/**
 * Idempotencia de un intento de compra respaldada por la base: decide qué hacer cuando ya
 * existen ventas con la misma `Idempotency-Key` (columna `ventas.idempotency_key`).
 * Cada línea guarda `<key>:<huella>:<índice>`; las filas con el formato anterior
 * `<key>:<índice>` (sin huella) se reconocen y no se comparan por contenido.
 * Sin I/O: la lectura y la liberación de keys las hace la transacción de la reserva.
 */

const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const FINGERPRINT_LENGTH = 12;
const LEGACY_PARTS = 2;

const PENDING = 'pendiente';
// Intentos que ya no retienen stock ni cobran: su key se puede liberar para un intento nuevo.
const DEAD_STATUSES = new Set(['cancelado', 'expirado']);

const KEY_REUSED = {
  ok: false,
  status: HTTP_UNPROCESSABLE,
  code: 'IDEMPOTENCY_KEY_REUSED',
  message: 'Esta compra ya fue iniciada con otros datos. Volvé al carrito e iniciá una nueva compra.',
};

const ATTEMPT_CLOSED = {
  ok: false,
  status: HTTP_CONFLICT,
  code: 'CHECKOUT_ATTEMPT_CLOSED',
  message: 'Esta compra ya fue procesada. Revisala en "Mis compras" o iniciá una nueva desde el carrito.',
};

/** Huella corta que se guarda en la fila: incluye el medio de pago, así una key no cruza mp/transferencia. */
const attemptFingerprint = (digest) => String(digest).slice(0, FINGERPRINT_LENGTH);

const buildRowKey = (key, fingerprint, lineIndex) => `${key}:${fingerprint}:${lineIndex}`;

const parseRowKey = (stored) => {
  const parts = String(stored).split(':');
  const lineIndex = Number(parts[parts.length - 1]);
  return { fingerprint: parts.length > LEGACY_PARTS ? parts[1] : null, lineIndex };
};

const byLineIndex = (a, b) => a.lineIndex - b.lineIndex;

/**
 * @param {object[]} rows ventas existentes de la key (`findByIdempotencyKey`)
 * @returns {null                                    // no hay intento previo: reservar normalmente
 *   | {action: 'release', ids: string[]}           // intento muerto: liberar la key y reservar de nuevo
 *   | {action: 'replay', orderIds: string[], orderNumber: number|null, purchaseId: string|null}
 *   | {action: 'fail', failure: object}}
 */
const resolveExistingAttempt = (rows, fingerprint) => {
  if (rows.length === 0) return null;
  if (rows.every((row) => DEAD_STATUSES.has(row.payment_status))) {
    return { action: 'release', ids: rows.map((row) => String(row.id)) };
  }
  const parsed = rows.map((row) => ({ row, ...parseRowKey(row.idempotency_key) })).sort(byLineIndex);
  if (parsed.some((entry) => entry.fingerprint !== null && entry.fingerprint !== fingerprint)) {
    return { action: 'fail', failure: KEY_REUSED };
  }
  if (!parsed.every((entry) => entry.row.payment_status === PENDING)) {
    return { action: 'fail', failure: ATTEMPT_CLOSED };
  }
  const [first] = parsed;
  return {
    action: 'replay',
    orderIds: parsed.map((entry) => String(entry.row.id)),
    orderNumber: first.row.order_number ?? null,
    purchaseId: first.row.mp_external_reference ?? null,
  };
};

module.exports = { attemptFingerprint, buildRowKey, resolveExistingAttempt, KEY_REUSED, ATTEMPT_CLOSED };
