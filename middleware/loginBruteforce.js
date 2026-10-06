// In-memory tracker de fuerza bruta en login, por email.
//
// El rate limit por IP de userRoutes.js (loginLimit) no alcanza solo: un
// atacante distribuido en varias IPs puede seguir probando contraseñas contra
// la MISMA cuenta sin tocar ningún límite por IP. Esto agrega backoff
// progresivo por cuenta, igual que pide skill 04 (auth endpoints).
//
// ⚠️ Estado en memoria del proceso, igual que rateLimit.js y signupTracker.js:
// correcto con una sola instancia (Railway hoy); con más de una hay que mover
// el store a algo compartido (Redis).

const store = new Map(); // email -> { failCount, lockedUntil, windowStart }

const WINDOW_MS = 15 * 60 * 1000; // el conteo se reinicia si pasó esto desde el primer fallo
const FREE_ATTEMPTS = 3; // fallos sin penalidad
const BASE_LOCK_MS = 30 * 1000; // primer bloqueo
const MAX_LOCK_MS = 15 * 60 * 1000; // techo del backoff exponencial

// Tope duro de cuentas rastreadas: sin él, un atacante que pruebe millones de
// emails distintos infla el Map sin límite hasta agotar la memoria del proceso.
const MAX_TRACKED_ACCOUNTS = 10000;
const PURGE_INTERVAL_MS = 60 * 1000;

const keyOf = (email) => email.toLowerCase().trim();

const getRecord = (email) => {
  const record = store.get(keyOf(email));
  if (!record || Date.now() - record.windowStart > WINDOW_MS) return null;
  return record;
};

/** @returns {{locked: boolean, retryAfterSeconds: number}} */
const checkLock = (email) => {
  const record = getRecord(email);
  if (!record) return { locked: false, retryAfterSeconds: 0 };

  const now = Date.now();
  const locked = now < record.lockedUntil;
  return { locked, retryAfterSeconds: locked ? Math.ceil((record.lockedUntil - now) / 1000) : 0 };
};

/** Descarta registros cuya ventana ya venció (y cuyo bloqueo, si lo hubo, terminó). */
const purgeExpired = () => {
  const now = Date.now();
  for (const [key, record] of store) {
    if (now - record.windowStart > WINDOW_MS && now >= record.lockedUntil) store.delete(key);
  }
};

/** Si se supera el tope, se descartan los registros más viejos (el Map conserva el orden de inserción). */
const enforceCapacity = () => {
  for (const key of store.keys()) {
    if (store.size <= MAX_TRACKED_ACCOUNTS) return;
    store.delete(key);
  }
};

// unref: el timer de limpieza no debe impedir que el proceso termine.
setInterval(purgeExpired, PURGE_INTERVAL_MS).unref();

/** Registra un intento fallido y, a partir del 4°, aplica bloqueo exponencial. */
const recordFailure = (email) => {
  const existing = getRecord(email);
  const failCount = (existing?.failCount ?? 0) + 1;
  const now = Date.now();

  let lockedUntil = existing?.lockedUntil ?? 0;
  if (failCount > FREE_ATTEMPTS) {
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** (failCount - FREE_ATTEMPTS - 1), MAX_LOCK_MS);
    lockedUntil = now + lockMs;
  }

  store.set(keyOf(email), { failCount, lockedUntil, windowStart: existing?.windowStart ?? now });
  enforceCapacity();
};

/** Login exitoso: borra el historial de fallos de la cuenta. */
const recordSuccess = (email) => store.delete(keyOf(email));

module.exports = { checkLock, recordFailure, recordSuccess };
