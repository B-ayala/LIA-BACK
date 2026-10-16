/**
 * Idempotencia de creación de órdenes (header `Idempotency-Key`).
 *
 * Contrato con el frontend: una key por intento de compra. Reintentar con la misma
 * key y el mismo carrito devuelve la respuesta original en vez de crear otro juego
 * de ventas (que descontaría el stock dos veces vía trigger). La misma key con un
 * carrito distinto es un error del cliente (422), nunca una orden nueva.
 *
 * Solo se recuerdan las respuestas exitosas: un 409 (stock) o 502 (MP caído) dejó
 * todo sin persistir, así que el reintento con la misma key debe volver a ejecutarse.
 *
 * Almacenamiento en dos niveles:
 *  - `caches.idempotency` (memoria): camino rápido, evita ir a la base en el replay.
 *  - `public.idempotency_keys` (Supabase): sobrevive a reinicios de Render.
 * La base es fail-open: si falla (ej. migración sin aplicar) se loguea y se sigue con
 * solo memoria, porque cortar el checkout es peor que perder la garantía de replay.
 * El doble submit concurrente lo cubre el single-flight por carrito del controlador.
 */

const { caches } = require('./cache');
const IdempotencyKey = require('../models/IdempotencyKey');
const logger = require('./logger');

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

// Menor que la expiración de la preferencia de MP (15 min): un replay no debe
// devolver un init_point ya vencido.
const REPLAY_TTL_SECONDS = 10 * 60;
const MS_PER_SECOND = 1000;

const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;

const INVALID_KEY_RESULT = {
  status: HTTP_BAD_REQUEST,
  body: {
    success: false,
    code: 'IDEMPOTENCY_KEY_INVALID',
    message: 'No se pudo procesar la compra. Recargá la página e intentá de nuevo.',
  },
};

const KEY_REUSED_RESULT = {
  status: HTTP_UNPROCESSABLE,
  body: {
    success: false,
    code: 'IDEMPOTENCY_KEY_REUSED',
    message: 'Esta compra ya fue iniciada con otros datos. Volvé al carrito e iniciá una nueva compra.',
  },
};

/**
 * @returns {{key: string | null} | {error: {status: number, body: object}}}
 *          `key: null` = el cliente no mandó header (se mantiene el comportamiento previo).
 */
const readIdempotencyKey = (req) => {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined) return { key: null };
  return KEY_PATTERN.test(raw) ? { key: raw } : { error: INVALID_KEY_RESULT };
};

const findSaved = async (scope, key, storeKey) => {
  const inMemory = caches.idempotency.get(storeKey);
  if (inMemory) return inMemory;

  try {
    const row = await IdempotencyKey.findFresh(scope, key, REPLAY_TTL_SECONDS);
    if (!row) return null;
    const saved = { fingerprint: row.fingerprint, result: { status: row.status, body: row.body } };
    caches.idempotency.set(storeKey, saved, REPLAY_TTL_SECONDS * MS_PER_SECOND);
    return saved;
  } catch (error) {
    logger.warn('idempotency_read_failed', { code: error.code, message: error.message });
    return null;
  }
};

const persist = async (scope, key, storeKey, fingerprint, result) => {
  caches.idempotency.set(storeKey, { fingerprint, result }, REPLAY_TTL_SECONDS * MS_PER_SECOND);
  try {
    await IdempotencyKey.save(scope, key, { fingerprint, status: result.status, body: result.body });
  } catch (error) {
    logger.warn('idempotency_write_failed', { code: error.code, message: error.message });
  }
};

/**
 * Ejecuta `execute` una sola vez por (scope, key) mientras haya una respuesta
 * exitosa recordada. `scope` debe incluir al usuario y el tipo de operación para
 * que una key no pueda cruzarse entre usuarios ni entre mp/transferencia.
 *
 * @param {{scope: string, key: string | null, fingerprint: string,
 *          execute: () => Promise<{status: number, body: object}>}} options
 */
const withIdempotency = async ({ scope, key, fingerprint, execute }) => {
  if (!key) return execute();

  const storeKey = `${scope}:${key}`;
  const saved = await findSaved(scope, key, storeKey);
  if (saved) {
    return saved.fingerprint === fingerprint ? saved.result : KEY_REUSED_RESULT;
  }

  const result = await execute();
  if (result.status === HTTP_CREATED) {
    await persist(scope, key, storeKey, fingerprint, result);
  }
  return result;
};

module.exports = { readIdempotencyKey, withIdempotency };
