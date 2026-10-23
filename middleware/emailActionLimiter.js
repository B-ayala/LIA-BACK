// In-memory tracker de intentos por email y por acción (reenviar confirmación,
// pedir reset de contraseña). Máximo 3 intentos reales cada 24hs, sin importar
// si Supabase respondió éxito o error: así no se puede eludir el límite
// reintentando ante cualquier respuesta.
//
// ⚠️ Estado en memoria del proceso, igual que loginBruteforce.js y rateLimit.js:
// correcto con una sola instancia; con más de una instancia hay que mover el
// store a algo compartido (Redis).

const { createBoundedStore } = require('../utils/boundedStore');

const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const MAX_TRACKED_KEYS = 10000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

const store = createBoundedStore({
  maxEntries: MAX_TRACKED_KEYS,
  isExpired: (record) => Date.now() - record.windowStart > WINDOW_MS,
  purgeIntervalMs: PURGE_INTERVAL_MS,
}); // `${action}:${email}` -> { count, windowStart }

const keyOf = (action, email) => `${action}:${email.toLowerCase().trim()}`;

const getRecord = (action, email) => {
  const record = store.get(keyOf(action, email));
  if (!record || Date.now() - record.windowStart > WINDOW_MS) return null;
  return record;
};

/** @returns {{allowed: boolean, retryAfterSeconds: number}} */
const checkLimit = (action, email) => {
  const record = getRecord(action, email);
  if (!record) return { allowed: true, retryAfterSeconds: 0 };
  const allowed = record.count < MAX_ATTEMPTS;
  const retryAfterSeconds = allowed ? 0 : Math.ceil((record.windowStart + WINDOW_MS - Date.now()) / 1000);
  return { allowed, retryAfterSeconds };
};

/** Registra un intento. Se llama siempre que se decide seguir adelante con el envío. */
const recordAttempt = (action, email) => {
  const existing = getRecord(action, email);
  const count = (existing?.count ?? 0) + 1;
  store.set(keyOf(action, email), { count, windowStart: existing?.windowStart ?? Date.now() });
};

module.exports = { checkLimit, recordAttempt, MAX_ATTEMPTS };
