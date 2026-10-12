/**
 * Stock por talle (`productos.variants[].stockByOption`).
 *
 * Un producto puede llevar el stock por opción de la variante "Talle" además
 * del total en `productos.stock` (que es la suma). El trigger de la base solo
 * descuenta el total, así que el desglose por talle lo mantiene el backend con
 * estas funciones puras, dentro de la misma transacción que reserva la venta.
 *
 * `unitsConfig` es la selección por unidad que manda el front: un objeto por
 * unidad comprada, p. ej. [{ Color: 'Rojo', Talle: 'M' }, { Color: 'Rojo', Talle: 'L' }].
 */

const SIZE_VARIANT_PREFIX = 'talle';

const DEDUCT = -1;
const RESTORE = 1;

const REASON = {
  missingSize: 'MISSING_SIZE',
  unknownSize: 'UNKNOWN_SIZE',
  noStockForSize: 'NO_STOCK_FOR_SIZE',
};

// El catálogo guarda los talles en mayúsculas (sanitizeVariant del front).
const normalizeSize = (value) => String(value ?? '').trim().toUpperCase();

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

const isSizeVariantName = (name) =>
  typeof name === 'string' && name.trim().toLowerCase().startsWith(SIZE_VARIANT_PREFIX);

/** Variante de talle que controla stock por opción, o null si el stock es solo a nivel producto. */
const findSizeStockVariant = (variants) => {
  if (!Array.isArray(variants)) return null;
  const found = variants.find((variant) =>
    variant
    && isSizeVariantName(variant.name)
    && variant.stockByOption
    && typeof variant.stockByOption === 'object'
    && Object.values(variant.stockByOption).some(Number.isFinite)
  );
  return found || null;
};

const readUnitSize = (sizeVariant, unit) => normalizeSize(unit && unit[sizeVariant.name]);

/** Cuenta unidades por talle; `missing` son las unidades sin talle elegido. */
const countUnitsBySize = (sizeVariant, unitsConfig) => {
  const counts = {};
  let missing = 0;
  for (const unit of unitsConfig) {
    const size = readUnitSize(sizeVariant, unit);
    if (!size) {
      missing += 1;
    } else {
      counts[size] = (counts[size] || 0) + 1;
    }
  }
  return { counts, missing };
};

const asUnitsArray = (unitsConfig) => (Array.isArray(unitsConfig) ? unitsConfig : []);

/**
 * Valida que haya stock por talle para las unidades pedidas.
 * @returns {{ok: true} | {ok: false, reason: string, size?: string}}
 */
const validateSizeStock = (variants, unitsConfig, quantity) => {
  const sizeVariant = findSizeStockVariant(variants);
  if (!sizeVariant) return { ok: true };

  const units = asUnitsArray(unitsConfig);
  const { counts, missing } = countUnitsBySize(sizeVariant, units);
  if (units.length !== quantity || missing > 0) {
    return { ok: false, reason: REASON.missingSize };
  }

  for (const [size, needed] of Object.entries(counts)) {
    if (!hasOwn(sizeVariant.stockByOption, size)) {
      return { ok: false, reason: REASON.unknownSize, size };
    }
    if (needed > Math.max(0, Number(sizeVariant.stockByOption[size]) || 0)) {
      return { ok: false, reason: REASON.noStockForSize, size };
    }
  }
  return { ok: true };
};

const applyDelta = (current, delta, direction) => {
  const base = Math.max(0, Number(current) || 0);
  return direction === DEDUCT ? Math.max(0, base - delta) : base + delta;
};

/**
 * Devuelve las variantes con el stock por talle ajustado, o null si no hay nada
 * que cambiar (producto sin stock por talle o sin unidades con talle conocido).
 * Al restaurar se ignoran los talles que el admin ya quitó del producto.
 * @param {1|-1} direction RESTORE (+1) o DEDUCT (-1)
 */
const applySizeDelta = (variants, unitsConfig, direction) => {
  const sizeVariant = findSizeStockVariant(variants);
  if (!sizeVariant) return null;

  const { counts } = countUnitsBySize(sizeVariant, asUnitsArray(unitsConfig));
  const knownSizes = Object.keys(counts).filter((size) => hasOwn(sizeVariant.stockByOption, size));
  if (knownSizes.length === 0) return null;

  const stockByOption = { ...sizeVariant.stockByOption };
  for (const size of knownSizes) {
    stockByOption[size] = applyDelta(stockByOption[size], counts[size], direction);
  }
  return variants.map((variant) => (variant === sizeVariant ? { ...variant, stockByOption } : variant));
};

module.exports = {
  DEDUCT,
  RESTORE,
  REASON,
  normalizeSize,
  isSizeVariantName,
  findSizeStockVariant,
  validateSizeStock,
  applySizeDelta,
};
