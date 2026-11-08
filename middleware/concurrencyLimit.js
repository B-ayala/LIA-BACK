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
 *
 * Hay un bulkhead por *carril* (lecturas, auth, checkout con Mercado Pago, órdenes locales sin
 * Mercado Pago, admin, webhook de Mercado Pago) y no uno solo: con uno global, una dependencia lenta (MP,
 * Cloudinary, Supabase Auth) consumía los mismos slots que el catálogo y un pico
 * de lecturas demoraba la confirmación de pagos. Cada carril degrada por su cuenta.
 */

const logger = require('../utils/logger');
const { pathWithoutQuery } = require('../utils/requestPath');

const parseIntEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

class Bulkhead {
  /** `group`: otro Bulkhead cuyo presupuesto comparte este carril (ver `acquireLane`). */
  constructor({ name, maxConcurrent, maxQueue, queueTimeoutMs, group = null }) {
    this.name = name;
    this.group = group;
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
 * Carriles y sus topes por defecto. Regla de dimensionamiento (pool = `DB_POOL_MAX`, 12):
 *
 *  - Un slot de lectura/admin usa COMO MÁXIMO UNA conexión a la vez (los handlers corren sus consultas
 *    en serie; ver `Product.findCatalogPage` / `findAdminPage`). Antes cada miss del catálogo pedía dos
 *    en paralelo y 12 slots podían tomar 24 conexiones: un catálogo en frío dejaba sin conexión al checkout.
 *  - Los carriles "generales" (read + auth + admin) comparten un presupuesto de conexiones de
 *    `pool - CRITICAL_DB_RESERVE` (grupo `general`, ver `Bulkhead.group`): lo demás del pool queda para
 *    checkout, órdenes locales y webhook aunque el tráfico público sature.
 *  - Los carriles críticos no comparten grupo: su slot incluye esperas a Mercado Pago (hasta ~5 s) en las
 *    que no se tiene conexión, así que más slots que conexiones es correcto. La reserva es de 5 conexiones
 *    para ellos; si los tres saturaran a la vez el pool los hace esperar `connectionTimeoutMillis`.
 *
 * Se ajustan con las pruebas de carga. `MAX_CONCURRENT_REQUESTS`, `MAX_QUEUED_REQUESTS` y
 * `QUEUE_TIMEOUT_MS` siguen siendo los defaults del carril de lecturas.
 */
const dbPoolMax = parseIntEnv('DB_POOL_MAX', 12);
const CRITICAL_DB_RESERVE = parseIntEnv('BULKHEAD_CRITICAL_DB_RESERVE', 5);
const MIN_GENERAL_DB_BUDGET = 2;
const GENERAL_GROUP = 'general';
const GENERAL_GROUP_QUEUE = 100;

const LANE_DEFAULTS = {
  read: { maxConcurrent: 6, maxQueue: 200, group: GENERAL_GROUP },
  auth: { maxConcurrent: 3, maxQueue: 50, group: GENERAL_GROUP },
  admin: { maxConcurrent: 3, maxQueue: 20, group: GENERAL_GROUP },
  // Checkout con Mercado Pago (preferencia, confirmar y cancelar pagos): el slot espera a MP.
  checkout: { maxConcurrent: 4, maxQueue: 50 },
  // Órdenes que NO llaman a Mercado Pago (transferencia, nudge): no deben quedar detrás de un MP lento.
  local: { maxConcurrent: 2, maxQueue: 50 },
  // Reservado: lo llama Mercado Pago y no debe competir con el tráfico público.
  webhook: { maxConcurrent: 3, maxQueue: 50 },
};
const DEFAULT_QUEUE_TIMEOUT_MS = 8000;

const generalGroup = new Bulkhead({
  name: GENERAL_GROUP,
  maxConcurrent: parseIntEnv('BULKHEAD_GENERAL_MAX', Math.max(MIN_GENERAL_DB_BUDGET, dbPoolMax - CRITICAL_DB_RESERVE)),
  maxQueue: GENERAL_GROUP_QUEUE,
  queueTimeoutMs: parseIntEnv('QUEUE_TIMEOUT_MS', DEFAULT_QUEUE_TIMEOUT_MS),
});
const groups = { [GENERAL_GROUP]: generalGroup };

const buildLane = (lane) => {
  const defaults = LANE_DEFAULTS[lane];
  const prefix = `BULKHEAD_${lane.toUpperCase()}`;
  const isRead = lane === 'read';
  return new Bulkhead({
    name: lane,
    group: defaults.group ? groups[defaults.group] : null,
    maxConcurrent: parseIntEnv(`${prefix}_MAX`, isRead ? parseIntEnv('MAX_CONCURRENT_REQUESTS', defaults.maxConcurrent) : defaults.maxConcurrent),
    maxQueue: parseIntEnv(`${prefix}_QUEUE`, isRead ? parseIntEnv('MAX_QUEUED_REQUESTS', defaults.maxQueue) : defaults.maxQueue),
    queueTimeoutMs: parseIntEnv('QUEUE_TIMEOUT_MS', DEFAULT_QUEUE_TIMEOUT_MS),
  });
};

const lanes = Object.fromEntries(Object.keys(LANE_DEFAULTS).map((lane) => [lane, buildLane(lane)]));

/** Toma el slot del carril y, si comparte presupuesto de conexiones, también el del grupo. */
const acquireLane = async (lane) => {
  const release = await lane.acquire();
  if (!release || !lane.group) return release;
  const releaseGroup = await lane.group.acquire();
  if (!releaseGroup) {
    release();
    return null;
  }
  return () => {
    releaseGroup();
    release();
  };
};

const ADMIN_PREFIXES = ['/admin', '/users', '/cloudinary'];

/**
 * Carril de una request. `path` es relativo al mount `/api` (ej. `/orders/mp-webhook`).
 * Las lecturas de "mis compras" (GET /orders) van al carril público: no deben
 * competir con el checkout. Confirmar y cancelar pagos sí van a checkout porque
 * consultan a Mercado Pago, igual que crear la compra. La transferencia y el nudge
 * no llaman a Mercado Pago y tienen su propio carril (`local`).
 */
const LOCAL_ORDER_PATHS = ['/orders/transfer', '/orders/nudge'];

const laneFor = (method, path) => {
  if (path.startsWith('/orders/mp-webhook')) return 'webhook';
  if (path.startsWith('/orders')) {
    if (method === 'GET') return 'read';
    if (method === 'PATCH') return 'admin';
    return LOCAL_ORDER_PATHS.some((prefix) => path.startsWith(prefix)) ? 'local' : 'checkout';
  }
  if (path.startsWith('/auth')) return 'auth';
  if (ADMIN_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'admin';
  return 'read';
};

const RETRY_AFTER_SECONDS = 2;

const concurrencyLimit = (req, res, next) => {
  const laneName = laneFor(req.method, req.path);
  const bulkhead = lanes[laneName];

  // Si el cliente se va mientras la request espera en la cola, el slot que le
  // toque no debe quedar tomado: en ese momento todavía no hay listeners de
  // liberación puestos, y sin esta marca el `close` ya ocurrido no se vuelve a
  // emitir y el slot se pierde para siempre (se detectó saturando con 800
  // requests concurrentes: la cola quedaba llena con 0 handlers activos).
  let clientGone = false;
  const markClientGone = () => { clientGone = true; };
  res.once('close', markClientGone);

  acquireLane(bulkhead)
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
          lane: laneName,
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

/** Estadísticas por carril: `{ read: {...}, auth: {...}, ... }`. */
const concurrencyStats = () => ({
  ...Object.fromEntries(Object.entries(lanes).map(([name, lane]) => [name, lane.stats()])),
  [GENERAL_GROUP]: generalGroup.stats(),
});

module.exports = { concurrencyLimit, concurrencyStats, Bulkhead, laneFor, lanes, acquireLane, generalGroup };
