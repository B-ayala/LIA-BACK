/**
 * Rate limiting por endpoint (ventana deslizante por contador de tramos).
 *
 * Por qué propio y no `express-rate-limit`: la única funcionalidad que se
 * necesita son ventanas cortas por IP/usuario con headers estándar, y el
 * proyecto ya evita dependencias que no aportan (ver skill 06). El algoritmo es
 * *sliding window counter*: se pondera el tramo anterior según cuánto queda de
 * la ventana actual, lo que evita el pico de borde del contador fijo.
 *
 * ⚠️ El estado vive en memoria del proceso. Con una sola instancia (Railway hoy)
 * es correcto; si se escala horizontalmente hay que mover el store a Redis.
 * `createRateLimit` deja el store inyectable para no tener que reescribir esto.
 */

const logger = require('../utils/logger');
const { pathWithoutQuery } = require('../utils/requestPath');

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_TRACKED_KEYS = 20000;

/** IP real del cliente: detrás del proxy de Railway hay que mirar X-Forwarded-For. */
const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/** Identifica al llamador: usuario autenticado si lo hay, IP si no. */
const defaultKeyGenerator = (req) => (req.user && req.user.id ? `u:${req.user.id}` : `ip:${clientIp(req)}`);

class SlidingWindowStore {
  constructor() {
    this.buckets = new Map(); // key -> { windowStart, count, prevCount }
    this.timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Registra un hit y devuelve el conteo ponderado de la ventana deslizante. */
  hit(key, windowMs) {
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // Cota de memoria: ante un pico de claves únicas (IPs rotando) se limpia
      // lo vencido antes de seguir creciendo.
      if (this.buckets.size >= MAX_TRACKED_KEYS) this.cleanup();
      bucket = { windowStart, count: 0, prevCount: 0 };
      this.buckets.set(key, bucket);
    } else if (bucket.windowStart !== windowStart) {
      const isPreviousWindow = windowStart - bucket.windowStart === windowMs;
      bucket.prevCount = isPreviousWindow ? bucket.count : 0;
      bucket.count = 0;
      bucket.windowStart = windowStart;
    }

    bucket.count += 1;

    const elapsedRatio = (now - windowStart) / windowMs;
    const weighted = bucket.prevCount * (1 - elapsedRatio) + bucket.count;

    return { weighted, resetAt: windowStart + windowMs };
  }

  cleanup() {
    const cutoff = Date.now() - CLEANUP_INTERVAL_MS;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < cutoff) this.buckets.delete(key);
    }
  }

  size() {
    return this.buckets.size;
  }
}

const sharedStore = new SlidingWindowStore();

/**
 * @param {object} options
 * @param {string} options.name      Identificador del límite (aparece en la clave y en los logs).
 * @param {number} options.windowMs  Tamaño de la ventana.
 * @param {number} options.max       Máximo de requests por ventana y por clave.
 * @param {Function} [options.keyGenerator]
 * @param {Function} [options.skip]  Devuelve true para saltear el límite (health checks, etc.).
 */
const createRateLimit = ({ name, windowMs, max, keyGenerator = defaultKeyGenerator, skip, store = sharedStore }) => {
  const windowSeconds = Math.ceil(windowMs / 1000);

  return (req, res, next) => {
    if (typeof skip === 'function' && skip(req)) return next();

    const key = `${name}:${keyGenerator(req)}`;
    const { weighted, resetAt } = store.hit(key, windowMs);
    const remaining = Math.max(0, max - Math.ceil(weighted));

    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000));

    if (weighted <= max) return next();

    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', retryAfter);

    // Se loguea el bloqueo (skill 04: logging de abuso) sin exponer PII: la
    // clave ya es un id de usuario o una IP, nunca email ni token.
    logger.warn('rate_limit_blocked', {
      limit: name,
      key,
      method: req.method,
      path: pathWithoutQuery(req),
      windowSeconds,
      max,
    });

    return res.status(429).json({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Demasiadas solicitudes. Esperá unos segundos y volvé a intentar.',
    });
  };
};

const rateLimitStats = () => ({ trackedKeys: sharedStore.size() });

module.exports = { createRateLimit, rateLimitStats, clientIp };
