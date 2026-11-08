/**
 * Invalidación SELECTIVA del catálogo cacheado ante movimientos de stock.
 *
 * Reservar, liberar, expirar o saldar una venta mueve el stock decenas de veces por hora. Vaciar el
 * catálogo en cada una (como se hacía) tiraba la caché justo cuando más tráfico había y mandaba una
 * ráfaga de misses a la base. Regla actual:
 *  - el stock numérico que muestra el catálogo puede atrasarse hasta `TTL.products` (20 s por defecto);
 *  - lo que SÍ se invalida de inmediato es un cambio de DISPONIBILIDAD visible: un producto (o uno de
 *    sus talles) que pasa de tener stock a no tenerlo, o al revés. Eso cambia "Sin stock", los
 *    botones de compra y los facets de talle/color.
 * Los cambios del admin (alta, edición, borrado, orden de categorías) siguen usando `invalidateProducts()`.
 *
 * Las capas de datos avisan con `noteStockChange` DENTRO de la transacción y el caller, ya con el COMMIT
 * hecho, llama `flushAvailabilityChange`. La marca es una variable del proceso a propósito: los puntos que
 * mueven stock están repartidos en modelos distintos y devolver el aviso por cada firma obligaba a
 * cambiar una decena de contratos. Si una transacción hace ROLLBACK la marca sobra y solo cuesta un
 * vaciado de más; si otra request vacía justo antes del COMMIT, el atraso máximo sigue siendo el TTL.
 */

const { invalidateProducts } = require('./cache');
const { findSizeStockVariant } = require('./variantStock');

let pendingAvailabilityChange = false;

const hasStock = (value) => Number(value) > 0;

/** Mapa `talle -> ¿hay stock?` del stock por talle, o null si el producto no lo controla por talle. */
const sizeAvailability = (variants) => {
  const sizeVariant = findSizeStockVariant(variants);
  if (!sizeVariant) return null;
  return Object.entries(sizeVariant.stockByOption).map(([size, value]) => [size, hasStock(value)]);
};

const sameAvailability = (before, after) => {
  if (before === null || after === null) return before === after;
  return JSON.stringify(before) === JSON.stringify(after);
};

const totalStockFlipped = (before, after) =>
  before.stock != null && after.stock != null && hasStock(before.stock) !== hasStock(after.stock);

/**
 * ¿Cambió lo que el comprador ve como disponible?
 * @param {{stock: number|null, variants: unknown}} before
 * @param {{stock: number|null, variants: unknown}} after
 */
const availabilityChanged = (before, after) =>
  totalStockFlipped(before, after)
  || !sameAvailability(sizeAvailability(before.variants), sizeAvailability(after.variants));

/** Deja anotado que hay que vaciar el catálogo si el movimiento de stock cambió la disponibilidad. */
const noteStockChange = (before, after) => {
  if (availabilityChanged(before, after)) pendingAvailabilityChange = true;
};

/**
 * Vacía el catálogo SOLO si algún movimiento de stock anotado cambió la disponibilidad.
 * @returns {boolean} true si vació.
 */
const flushAvailabilityChange = () => {
  if (!pendingAvailabilityChange) return false;
  pendingAvailabilityChange = false;
  invalidateProducts();
  return true;
};

module.exports = { availabilityChanged, noteStockChange, flushAvailabilityChange };
