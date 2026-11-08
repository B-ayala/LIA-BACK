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

const crypto = require('crypto');
const net = require('net');
const logger = require('../utils/logger');
const { pathWithoutQuery } = require('../utils/requestPath');

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// Tope DURO de claves en memoria. Al alcanzarlo se limpia lo vencido y, si aún no hay lugar, se descarta
// la clave más antigua: una inundación de claves únicas (IPs rotando) no puede hacer crecer el proceso.
// Costo asumido: bajo un ataque así algún contador viejo se reinicia antes de tiempo.
const MAX_TRACKED_KEYS = 20000;
// Mínimo entre dos barridos completos forzados por el tope: sin esto cada clave nueva con el mapa lleno
// recorrería las 20000 entradas.
const FORCED_CLEANUP_MIN_GAP_MS = 1000;
const IPV6_GROUPS = 8;
const IPV6_PREFIX_GROUPS = 4;
const HEX_RADIX = 16;
const LOG_KEY_HASH_LENGTH = 12;
const IPV4_MAPPED_IPV6 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** IP real del cliente: detrás del proxy de la plataforma hay que mirar X-Forwarded-For. */
const clientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/** Grupos de 16 bits de una IPv6 (admite `::` y un sufijo IPv4 embebido). */
const expandIpv6 = (ip) => {
  const withoutZone = ip.split('%')[0];
  const [head, tail = ''] = withoutZone.split('::');
  const toGroups = (text) => (text ? text.split(':').flatMap((group) => (group.includes('.') ? ['0', '0'] : [group])) : []);
  const headGroups = toGroups(head);
  const tailGroups = withoutZone.includes('::') ? toGroups(tail) : [];
  const fill = new Array(Math.max(0, IPV6_GROUPS - headGroups.length - tailGroups.length)).fill('0');
  return [...headGroups, ...fill, ...tailGroups].map((group) => Number.parseInt(group, HEX_RADIX).toString(HEX_RADIX));
};

/**
 * Clave estable de una IP para el rate limit: una IPv6 se agrupa por su /64 (un cliente recibe un /64
 * entero y rotar dentro de él no debe darle un contador nuevo por request); una IPv4 mapeada se reduce
 * a la IPv4.
 */
const ipKey = (ip) => {
  const mapped = IPV4_MAPPED_IPV6.exec(ip);
  if (mapped) return mapped[1];
  if (!net.isIPv6(ip)) return ip;
  return `${expandIpv6(ip).slice(0, IPV6_PREFIX_GROUPS).join(':')}::/64`;
};

/** Identifica al llamador: usuario autenticado si lo hay, IP (IPv6 por /64) si no. */
const defaultKeyGenerator = (req) => (req.user && req.user.id ? `u:${req.user.id}` : `ip:${ipKey(clientIp(req))}`);

class SlidingWindowStore {
  /** `now` y `maxKeys` son inyectables para probar el reloj y el tope sin esperar ni crear 20000 claves. */
  constructor({ now = Date.now, maxKeys = MAX_TRACKED_KEYS } = {}) {
    this.now = now;
    this.maxKeys = maxKeys;
    this.lastForcedCleanupAt = 0;
    this.buckets = new Map(); // key -> { windowStart, count, prevCount }
    this.timer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Hace lugar para UNA clave nueva respetando el tope duro. */
  makeRoom() {
    if (this.buckets.size < this.maxKeys) return;
    const now = this.now();
    if (now - this.lastForcedCleanupAt >= FORCED_CLEANUP_MIN_GAP_MS) {
      this.lastForcedCleanupAt = now;
      this.cleanup();
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
  }

  /** Registra un hit y devuelve el conteo ponderado de la ventana deslizante. */
  hit(key, windowMs) {
    const now = this.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    let bucket = this.buckets.get(key);

    if (!bucket) {
      this.makeRoom();
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
    const cutoff = this.now() - CLEANUP_INTERVAL_MS;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStart < cutoff) this.buckets.delete(key);
    }
  }

  size() {
    return this.buckets.size;
  }
}

const sharedStore = new SlidingWindowStore();

// Solo 'ip' o 'user': otras claves (p. ej. un email) no se describen, ni siquiera por su prefijo.
const keyKindOf = (name, key) => {
  if (key.startsWith(`${name}:ip:`)) return 'ip';
  return key.startsWith(`${name}:u:`) ? 'user' : 'other';
};

const hashForLog = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, LOG_KEY_HASH_LENGTH);

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

    // Se loguea el bloqueo (logging de abuso) sin exponer PII: la clave (IP o id de usuario) viaja
    // hasheada. Sirve para contar y correlacionar bloqueos del mismo origen, no para identificarlo.
    logger.warn('rate_limit_blocked', {
      limit: name,
      keyKind: keyKindOf(name, key),
      keyHash: hashForLog(key),
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

module.exports = { createRateLimit, rateLimitStats, clientIp, ipKey, SlidingWindowStore, MAX_TRACKED_KEYS };
