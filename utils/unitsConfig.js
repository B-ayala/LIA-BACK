/**
 * Validación de la selección de variantes por unidad (`unitsConfig`) contra las
 * variantes REALES del producto (fila bloqueada en la reserva), no contra lo que
 * diga el body.
 *
 * Reglas (mismas que `areUnitVariantSelectionsValid` del front):
 *  - Producto sin variantes con opciones → no hay nada que elegir: se guarda `[]`.
 *  - Producto con variantes → una selección por unidad (`length === quantity`) y,
 *    en cada unidad, una opción existente de cada variante. El talle se compara
 *    sin distinguir mayúsculas (el catálogo lo guarda en mayúsculas).
 * Lo que se persiste es la selección saneada: solo variantes conocidas y con la
 * opción tal como figura en el catálogo, nunca el JSON arbitrario del cliente.
 */

const { isSizeVariantName, normalizeSize } = require('./variantStock');

const UNITS_PROBLEM = Object.freeze({
  sizeRequired: 'SIZE_REQUIRED',
  sizeUnavailable: 'SIZE_UNAVAILABLE',
  invalidVariant: 'INVALID_VARIANT',
});

const normalizeOption = (isSize, value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return isSize ? normalizeSize(value) : String(value).trim();
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Variantes que exigen elección: con nombre y al menos una opción no vacía. */
const selectableVariants = (variants) => {
  if (!Array.isArray(variants)) return [];
  return variants
    .filter((variant) => isPlainObject(variant) && typeof variant.name === 'string'
      && variant.name.trim() && Array.isArray(variant.options))
    .map((variant) => {
      const isSize = isSizeVariantName(variant.name);
      const options = variant.options.map((option) => normalizeOption(isSize, option)).filter(Boolean);
      return { name: variant.name, isSize, options };
    })
    .filter((variant) => variant.options.length > 0);
};

/** @returns {{value: string} | {problem: string, size?: string}} */
const pickOption = (variant, unit) => {
  const value = normalizeOption(variant.isSize, isPlainObject(unit) ? unit[variant.name] : undefined);
  if (!value) {
    return { problem: variant.isSize ? UNITS_PROBLEM.sizeRequired : UNITS_PROBLEM.invalidVariant };
  }
  if (!variant.options.includes(value)) {
    return variant.isSize
      ? { problem: UNITS_PROBLEM.sizeUnavailable, size: value }
      : { problem: UNITS_PROBLEM.invalidVariant };
  }
  return { value };
};

const sanitizeUnit = (selectable, unit) => {
  const sanitized = {};
  for (const variant of selectable) {
    const picked = pickOption(variant, unit);
    if (picked.problem) return { ok: false, code: picked.problem, variant: variant.name, size: picked.size };
    sanitized[variant.name] = picked.value;
  }
  return { ok: true, unit: sanitized };
};

/**
 * @returns {{ok: true, units: object[]} | {ok: false, code: string, variant?: string, size?: string}}
 */
const validateUnitsConfig = (variants, unitsConfig, quantity) => {
  const selectable = selectableVariants(variants);
  if (selectable.length === 0) return { ok: true, units: [] };

  if (!Array.isArray(unitsConfig) || unitsConfig.length !== quantity) {
    const hasSize = selectable.some((variant) => variant.isSize);
    return { ok: false, code: hasSize ? UNITS_PROBLEM.sizeRequired : UNITS_PROBLEM.invalidVariant };
  }

  const units = [];
  for (const unit of unitsConfig) {
    const result = sanitizeUnit(selectable, unit);
    if (!result.ok) return result;
    units.push(result.unit);
  }
  return { ok: true, units };
};

module.exports = { UNITS_PROBLEM, validateUnitsConfig };
