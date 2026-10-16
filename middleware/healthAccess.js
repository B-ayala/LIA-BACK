const crypto = require('crypto');

/**
 * Quién puede ver el detalle de `/health` (pool de la base, bulkhead, claves de
 * rate limit, cachés): información de reconocimiento que un monitor externo no
 * necesita. Un monitor de uptime solo mira el status code y el `status`.
 *
 * - Con `HEALTH_DETAIL_TOKEN` definido: el detalle exige el header `x-health-token`
 *   con ese valor (comparación en tiempo constante).
 * - Sin token: el detalle se muestra solo fuera de producción (`qa/load-test.js` lo
 *   lee en local); en producción se responde únicamente `{ status, uptimeSeconds }`.
 */
const safeEqual = (received, expected) => {
  const left = Buffer.from(String(received));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const canSeeHealthDetail = (req) => {
  const expected = (process.env.HEALTH_DETAIL_TOKEN || '').trim();
  if (!expected) return process.env.NODE_ENV !== 'production';
  const received = req.headers['x-health-token'];
  return typeof received === 'string' && safeEqual(received, expected);
};

module.exports = { canSeeHealthDetail };
