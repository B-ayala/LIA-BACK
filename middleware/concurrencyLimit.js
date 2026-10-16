/**
 * Control de concurrencia (patrón *bulkhead* + cola con timeout).
 *
 * Problema que resuelve: Node acepta miles de requests en paralelo, pero el pool
 * de PostgreSQL tiene N conexiones. Sin control, 500 requests simultáneas se
 * apilan esperando `pool.connect()` y todas terminan fallando por
 * `connectionTimeoutMillis` después de segundos — el peor resultado posible:
 * lento Y roto.
 *
 * Con este middleware sólo `maxConcurrent` handlers tocan la base a la vez; el
 * resto espera en una cola acotada, y si la cola se llena se responde **503 con
 * Retry-After** de inmediato (load shedding). Degradar rápido y de forma
 * predecible es preferible a colapsar.
 */

const logger = require('../utils/logger');
const { pathWithoutQuery } = require('../utils/requestPath');

const parseIntEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

class Bulkhead {
  constructor({ name, maxConcurrent, maxQueue, queueTimeoutMs }) {
    this.name = name;
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.queueTimeoutMs = queueTimeoutMs;
    this.active = 0;
    this.queue = [];
    // `totalQueued` es acumulado; la profundidad instantánea de la cola se
    // publica aparte como `queueLength` (nombrarlos distinto evita que uno pise
    // al otro al serializar las métricas).
    this.metrics = { accepted: 0, totalQueued: 0, rejected: 0, timedOut: 0, maxObservedQueue: 0 };
  }

  /** @returns {Promise<Function|null>} función `release`, o null si se rechaza. */
  acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      this.metrics.accepted += 1;
      return Promise.resolve(() => this.release());
    }

    if (this.queue.length >= this.maxQueue) {
      this.metrics.rejected += 1;
      return Promise.resolve(null);
    }

    this.metrics.totalQueued += 1;
    this.metrics.maxObservedQueue = Math.max(this.metrics.maxObservedQueue, this.queue.length + 1);

    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };

      waiter.timer = setTimeout(() => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        this.metrics.timedOut += 1;
        resolve(null);
      }, this.queueTimeoutMs);

      this.queue.push(waiter);
    });
  }

  release() {
    const waiter = this.queue.shift();
    if (!waiter) {
      this.active -= 1;
      return;
    }
    clearTimeout(waiter.timer);
    this.metrics.accepted += 1;
    waiter.resolve(() => this.release()); // el slot activo se transfiere, no se libera
  }

  stats() {
    return {
      name: this.name,
      active: this.active,
      queueLength: this.queue.length,
      maxConcurrent: this.maxConcurrent,
      maxQueue: this.maxQueue,
      ...this.metrics,
    };
  }
}

/**
 * Bulkhead global de la API.
 *
 * El default se deriva del pool de PostgreSQL (2× `DB_POOL_MAX`) para que los
 * dos números no se desincronicen: no todo handler usa la base todo el tiempo,
 * pero admitir mucho más que eso sólo traslada la espera al pool, que responde
 * con un error feo (`EMAXCONNSESSION` / connection timeout) en vez de un 503
 * limpio con `Retry-After`.
 */
const dbPoolMax = parseIntEnv('DB_POOL_MAX', 12);

const bulkhead = new Bulkhead({
  name: 'api',
  maxConcurrent: parseIntEnv('MAX_CONCURRENT_REQUESTS', dbPoolMax * 2),
  maxQueue: parseIntEnv('MAX_QUEUED_REQUESTS', 200),
  queueTimeoutMs: parseIntEnv('QUEUE_TIMEOUT_MS', 8000),
});

const RETRY_AFTER_SECONDS = 2;

const concurrencyLimit = (req, res, next) => {
  // Si el cliente se va mientras la request espera en la cola, el slot que le
  // toque no debe quedar tomado: en ese momento todavía no hay listeners de
  // liberación puestos, y sin esta marca el `close` ya ocurrido no se vuelve a
  // emitir y el slot se pierde para siempre (se detectó saturando con 800
  // requests concurrentes: la cola quedaba llena con 0 handlers activos).
  let clientGone = false;
  const markClientGone = () => { clientGone = true; };
  res.once('close', markClientGone);

  bulkhead
    .acquire()
    .then((release) => {
      res.removeListener('close', markClientGone);

      // Cliente desconectado: se devuelve el slot (si lo hubo) y no se intenta
      // escribir sobre una respuesta ya cerrada.
      if (clientGone) {
        if (release) release();
        return undefined;
      }

      if (!release) {
        logger.warn('request_shed', {
          method: req.method,
          path: pathWithoutQuery(req),
          active: bulkhead.active,
          queueLength: bulkhead.queue.length,
        });
        res.setHeader('Retry-After', RETRY_AFTER_SECONDS);
        return res.status(503).json({
          success: false,
          code: 'SERVER_BUSY',
          message: 'El servidor está recibiendo muchas solicitudes. Reintentá en unos segundos.',
        });
      }

      // `finish` cubre la respuesta completa y `close` la desconexión del cliente
      // a mitad de camino; `once` sobre ambos con guard evita liberar dos veces.
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        release();
      };
      res.once('finish', releaseOnce);
      res.once('close', releaseOnce);

      return next();
    })
    .catch(next);
};

const concurrencyStats = () => bulkhead.stats();

module.exports = { concurrencyLimit, concurrencyStats, Bulkhead };
