/**
 * Caché en memoria con TTL y *single-flight* (coalescing de requests).
 *
 * Por qué en memoria y no Redis: el backend corre hoy como una única instancia
 * en Railway y los datos cacheados son de baja volatilidad y no sensibles
 * (catálogo público y agregados de analítica). Sumar Redis agregaría una
 * dependencia crítica más sin beneficio real a esta escala.
 *
 * ⚠️ Si algún día se escala a más de una instancia, cada proceso tendrá su
 * propia copia: los TTL son cortos justamente para acotar esa divergencia.
 *
 * El valor central acá es el single-flight: si 50 usuarios piden el catálogo a
 * la vez con la caché fría, se ejecuta UNA sola query y las 50 respuestas
 * comparten el resultado, en vez de abrir 50 conexiones del pool.
 */

const DEFAULT_MAX_ENTRIES = 500;
const PURGE_INTERVAL_MS = 60 * 1000;

class TtlCache {
  constructor({ name, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.name = name || 'cache';
    this.maxEntries = maxEntries;
    this.entries = new Map(); // key -> { value, expiresAt }
    this.inFlight = new Map(); // key -> Promise
    this.metrics = { hits: 0, misses: 0, coalesced: 0, evictions: 0 };

    // unref: un timer de limpieza no debe impedir que el proceso termine.
    this.purgeTimer = setInterval(() => this.purgeExpired(), PURGE_INTERVAL_MS);
    if (typeof this.purgeTimer.unref === 'function') this.purgeTimer.unref();
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (!(ttlMs > 0)) return value;

    // FIFO simple: la entrada más vieja sale primero. Suficiente para un set
    // acotado de claves (catálogo + insights), sin el costo de un LRU real.
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      this.metrics.evictions += 1;
    }

    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  delete(key) {
    this.entries.delete(key);
  }

  /** Invalida todas las claves de un namespace (ej. `products:`). */
  invalidatePrefix(prefix) {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear() {
    this.entries.clear();
  }

  purgeExpired() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  /**
   * Devuelve el valor cacheado o ejecuta `loader` una sola vez para todas las
   * llamadas concurrentes con la misma clave. `isCacheable` permite no guardar
   * ciertos resultados (ej. `null`) sin perder el single-flight.
   */
  async getOrSet(key, ttlMs, loader, { isCacheable = () => true } = {}) {
    const cached = this.get(key);
    if (cached !== undefined) {
      this.metrics.hits += 1;
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      this.metrics.coalesced += 1;
      return pending;
    }

    this.metrics.misses += 1;
    const promise = (async () => loader())()
      .then((value) => {
        if (isCacheable(value)) this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Single-flight sin cachear el resultado: colapsa solo las llamadas que están
   * en vuelo al mismo tiempo. Para operaciones que NO deben repetirse ante un
   * doble submit pero tampoco pueden servirse desde caché (ej. crear una orden).
   */
  async single(key, loader) {
    const pending = this.inFlight.get(key);
    if (pending) {
      this.metrics.coalesced += 1;
      return pending;
    }

    const promise = (async () => loader())().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  stats() {
    return { name: this.name, size: this.entries.size, inFlight: this.inFlight.size, ...this.metrics };
  }
}

/** TTLs configurables por entorno: permiten apagar la caché (0) sin tocar código. */
const ttlFromEnv = (name, fallbackMs) => {
  const seconds = Number.parseInt(process.env[name], 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
};

const caches = {
  products: new TtlCache({ name: 'products', maxEntries: 300 }),
  insights: new TtlCache({ name: 'insights', maxEntries: 50 }),
  auth: new TtlCache({ name: 'auth', maxEntries: 1000 }),
  orders: new TtlCache({ name: 'orders', maxEntries: 200 }),
  // Ids de producto inexistentes: separados del catálogo para que un scraper que
  // pida ids al azar no expulse las claves calientes (FIFO) de `products`.
  productMisses: new TtlCache({ name: 'productMisses', maxEntries: 100 }),
  idempotency: new TtlCache({ name: 'idempotency', maxEntries: 500 }),
};

const TTL = {
  products: ttlFromEnv('CACHE_TTL_PRODUCTS_SECONDS', 20 * 1000),
  insights: ttlFromEnv('CACHE_TTL_INSIGHTS_SECONDS', 60 * 1000),
  auth: ttlFromEnv('CACHE_TTL_AUTH_SECONDS', 30 * 1000),
};

const cacheStats = () => Object.values(caches).map((cache) => cache.stats());

/**
 * Invalida el catálogo cacheado. Se llama ante cualquier cambio de producto o
 * de stock (alta/edición/baja, creación de órdenes, cancelaciones, sweep de
 * expiración) para que el stock publicado no quede viejo más de lo necesario.
 */
const invalidateProducts = () => {
  caches.products.clear();
  caches.productMisses.clear();
};

module.exports = { TtlCache, caches, TTL, cacheStats, invalidateProducts };
