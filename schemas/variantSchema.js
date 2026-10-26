const { z } = require('zod');
const { isUuid } = require('../utils/uuid');
const { isSizeVariantName, normalizeSize } = require('../utils/variantStock');
const { findMeasurementsProblem, copyMeasurements } = require('./sizeSchema');

/**
 * Schema laxo de `productos.variants[]`: conserva cualquier campo que ya usa el
 * front (name/options/stockByOption/colorsByOption y los que se agreguen) y solo
 * valida con rigor `optionMeta`, la metadata de cada talle.
 */

const MAX_VARIANT_NAME = 100;
const MAX_OPTIONS = 100;
const MAX_OPTION_LENGTH = 100;
const SOURCE = { global: 'global', custom: 'custom' };

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @returns {string|null} problema de una entrada de `optionMeta`, o null. */
const findEntryProblem = (entry) => {
  if (!isPlainObject(entry)) return 'Cada opción debe ser un objeto.';
  const unknownKey = Object.keys(entry).find((key) => !['source', 'sizeId', 'measurements'].includes(key));
  if (unknownKey) return 'Campo no permitido en la opción.';

  if (entry.source === SOURCE.global) {
    if (!isUuid(entry.sizeId)) return 'sizeId debe ser un UUID válido.';
    if (entry.measurements !== undefined) return 'Un talle global no admite medidas propias.';
    return null;
  }
  if (entry.source === SOURCE.custom) {
    if (entry.sizeId !== undefined) return 'Un talle propio no admite sizeId.';
    return entry.measurements === undefined ? null : findMeasurementsProblem(entry.measurements);
  }
  return 'source debe ser "global" o "custom".';
};

const normalizeEntry = (entry) => {
  if (entry.source === SOURCE.global) return { source: SOURCE.global, sizeId: entry.sizeId.toLowerCase() };
  const normalized = { source: SOURCE.custom };
  if (entry.measurements !== undefined) normalized.measurements = copyMeasurements(entry.measurements);
  return normalized;
};

const findOptionMetaProblem = (variant, optionMeta) => {
  if (!isSizeVariantName(variant.name)) return 'Solo las variantes de talle admiten optionMeta.';
  if (!isPlainObject(optionMeta)) return 'optionMeta debe ser un objeto.';
  const knownOptions = new Set((variant.options || []).map(normalizeSize));
  for (const [key, entry] of Object.entries(optionMeta)) {
    if (!knownOptions.has(key)) return `La opción "${key}" de optionMeta no existe en options.`;
    const problem = findEntryProblem(entry);
    if (problem) return `optionMeta["${key}"]: ${problem}`;
  }
  return null;
};

const variantSchema = z.looseObject({
  name: z.string().trim().min(1).max(MAX_VARIANT_NAME),
  options: z.array(z.string().max(MAX_OPTION_LENGTH)).max(MAX_OPTIONS).optional(),
  optionMeta: z.unknown().optional(),
}).superRefine((variant, ctx) => {
  if (variant.optionMeta === undefined) return;
  const problem = findOptionMetaProblem(variant, variant.optionMeta);
  if (problem) ctx.addIssue({ code: 'custom', path: ['optionMeta'], message: problem });
}).transform((variant) => {
  if (variant.optionMeta === undefined) return variant;
  const optionMeta = Object.fromEntries(
    Object.entries(variant.optionMeta).map(([key, entry]) => [key, normalizeEntry(entry)])
  );
  return { ...variant, optionMeta };
});

/** sizeId de todas las opciones `global` de un conjunto de variantes (sin repetidos). */
const collectGlobalSizeIds = (variants) => {
  const ids = new Set();
  for (const variant of Array.isArray(variants) ? variants : []) {
    for (const entry of Object.values((variant && variant.optionMeta) || {})) {
      if (entry && entry.source === SOURCE.global) ids.add(entry.sizeId);
    }
  }
  return [...ids];
};

module.exports = { variantSchema, collectGlobalSizeIds };
