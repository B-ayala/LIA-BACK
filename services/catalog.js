/**
 * Lectura cacheada del catálogo público (`GET /api/products/catalog`).
 *
 * Tres cachés, todas LRU y con tope de entradas (ver `utils/cache.js`):
 *  - `catalog`: páginas con resultados, `TTL.products`. El stock numérico puede atrasarse hasta ese TTL;
 *    un cambio de disponibilidad o del admin vacía todo (ver `utils/catalogInvalidation.js`).
 *  - `catalogFacets`: talles/colores por categoría, `TTL.catalogFacets` (más largo: solo cambian con la
 *    disponibilidad o el admin, que invalidan).
 *  - `catalogMisses`: consultas sin resultados (categoría inventada, offset fuera de rango), TTL corto y
 *    aparte, para que un scraper de claves únicas no expulse las páginas calientes.
 * Página y facets se piden EN SERIE: un slot de lectura usa una sola conexión del pool a la vez.
 */

const Product = require('../models/Product');
const { caches, TTL } = require('../utils/cache');

const lowerAll = (values) => values.map((value) => value.toLowerCase());

/** Mayúsculas no cambian el resultado (la base compara sin distinguirlas): "Rojo" y "rojo" son la misma entrada. */
const pageCacheKey = ({ category, size, color, sort }, offset, limit) =>
  `catalog:${JSON.stringify([lowerAll(category), lowerAll(size), lowerAll(color), sort, offset, limit])}`;

/** Los facets dependen SOLO de la categoría. */
const facetsCacheKey = ({ category }) => `facets:${JSON.stringify(lowerAll(category))}`;

/**
 * Lee de `cache` (single-flight) y manda a `caches.catalogMisses` lo que `isEmpty` marque vacío.
 * @template T
 */
const cachedWithMisses = async (key, cache, ttlMs, loader, isEmpty) => {
  const missed = caches.catalogMisses.get(key);
  if (missed !== undefined) return missed;

  const value = await cache.getOrSet(key, ttlMs, loader, { isCacheable: (loaded) => !isEmpty(loaded) });
  if (isEmpty(value)) caches.catalogMisses.set(key, value, TTL.catalogMisses);
  return value;
};

const isEmptyFacets = (facets) => facets.sizes.length === 0 && facets.colors.length === 0;

/** @returns {Promise<{items: object[], hasMore: boolean, facets: {sizes: string[], colors: string[]}}>} */
const loadCatalog = async (filters, { offset, limit }) => {
  const page = await cachedWithMisses(
    pageCacheKey(filters, offset, limit),
    caches.catalog,
    TTL.products,
    () => Product.findCatalogItems(filters, { offset, limit }),
    (loaded) => loaded.items.length === 0
  );
  const facets = await cachedWithMisses(
    facetsCacheKey(filters),
    caches.catalogFacets,
    TTL.catalogFacets,
    () => Product.findCatalogFacets(filters),
    isEmptyFacets
  );
  return { ...page, facets };
};

module.exports = { loadCatalog, pageCacheKey, facetsCacheKey };
