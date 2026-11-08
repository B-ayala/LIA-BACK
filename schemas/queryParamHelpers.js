const { z } = require('zod');

/**
 * Piezas comunes de los schemas de query string (listado admin y catálogo público).
 * Un valor vacío (`?sort=`) equivale a "sin filtro", que es lo que manda un formulario en "Todas".
 */

const emptyToUndefined = (value) => (value === '' ? undefined : value);

const optionalText = (max) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const optionalEnum = (values) => z.preprocess(emptyToUndefined, z.enum(values).optional());

/** Entero sin signo de hasta 6 dígitos en [min, max]; ausente/vacío → `fallback`. */
const integerParam = (name, fallback, max, min = 1) => z.preprocess(
  emptyToUndefined,
  z.string().regex(/^\d{1,6}$/, `${name} debe ser un entero positivo`).transform(Number)
    .pipe(z.number().int().min(min, `${name} debe ser al menos ${min}`).max(max, `${name} no puede superar ${max}`))
    .optional()
).transform((value) => value ?? fallback);

module.exports = { emptyToUndefined, optionalText, optionalEnum, integerParam };
