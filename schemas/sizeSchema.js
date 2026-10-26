const { z } = require('zod');

/**
 * Validación de borde para /api/sizes y para las medidas propias de un talle
 * dentro de `productos.variants[].optionMeta`.
 */

const MAX_SIZE_NAME = 20;
const MAX_MEASUREMENTS = 8;
const MAX_MEASUREMENT_KEY = 30;
const MAX_MEASUREMENT_VALUE = 20;
const SIZE_TYPES = ['indumentaria', 'calzado'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @returns {string|null} mensaje del primer problema, o null si las medidas son válidas. */
const findMeasurementsProblem = (value) => {
  if (!isPlainObject(value)) return 'Las medidas deben ser un objeto.';
  const entries = Object.entries(value);
  if (entries.length > MAX_MEASUREMENTS) return `Máximo ${MAX_MEASUREMENTS} medidas por talle.`;
  for (const [key, measure] of entries) {
    if (FORBIDDEN_KEYS.has(key)) return 'Nombre de medida no permitido.';
    if (key.length < 1 || key.length > MAX_MEASUREMENT_KEY) {
      return `El nombre de la medida debe tener entre 1 y ${MAX_MEASUREMENT_KEY} caracteres.`;
    }
    if (typeof measure !== 'string' || measure.length > MAX_MEASUREMENT_VALUE) {
      return `El valor de la medida debe ser texto de hasta ${MAX_MEASUREMENT_VALUE} caracteres.`;
    }
  }
  return null;
};

/** Copia con prototipo nulo: las claves ya validadas no pueden tocar `Object.prototype`. */
const copyMeasurements = (value) => Object.fromEntries(Object.entries(value));

const measurementsSchema = z.unknown().superRefine((value, ctx) => {
  const problem = findMeasurementsProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
}).transform(copyMeasurements);

const sizeNameSchema = z.string().trim().min(1, 'El nombre es requerido')
  .max(MAX_SIZE_NAME, `Máximo ${MAX_SIZE_NAME} caracteres`)
  .transform((name) => name.toUpperCase());

const createSizeSchema = z.strictObject({
  name: sizeNameSchema,
  type: z.enum(SIZE_TYPES),
  measurements: measurementsSchema.optional(),
});

const updateSizeSchema = z.strictObject({
  name: sizeNameSchema.optional(),
  type: z.enum(SIZE_TYPES).optional(),
  measurements: measurementsSchema.optional(),
  active: z.boolean().optional(),
});

module.exports = {
  createSizeSchema,
  updateSizeSchema,
  measurementsSchema,
  findMeasurementsProblem,
  copyMeasurements,
  SIZE_TYPES,
};
