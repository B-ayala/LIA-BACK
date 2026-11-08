const { z } = require('zod');
const { optionalEnum, integerParam } = require('./queryParamHelpers');

/**
 * Query string de `GET /api/products/catalog` (público).
 *
 * Estricto: parámetro desconocido, `sort`/`offset`/`limit` repetidos o con forma de objeto
 * (`?sort[x]=1`) es 400. `category`, `size` y `color` admiten VARIOS valores repitiendo el
 * parámetro (`?category=Ropa&category=Remeras`); no se parte por comas porque una categoría
 * puede contener una. Los valores vacíos se descartan. Sin valores = sin filtro.
 *
 * El resultado sale canónico (espacios colapsados, sin repetidos sin distinguir mayúsculas,
 * ordenado): dos URLs equivalentes comparten la misma clave de caché.
 */

const SORT_VALUES = ['newest', 'price_asc', 'price_desc', 'name_asc', 'name_desc'];
const DEFAULT_SORT = 'newest';

const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 48;
// Un offset sin tope permite llenar la caché con páginas vacías. 2400 = 100 páginas de 24 (el tamaño que usa
// el front, que pide con offset = filas recibidas): muy por encima de cualquier catálogo real. No se exige
// que sea múltiplo de `limit` porque el front calcula el offset como cantidad de filas ya recibidas.
const MAX_OFFSET = 2400;

const MAX_CATEGORIES = 40;
const MAX_CATEGORY_LENGTH = 100;
const MAX_SIZES = 12;
const MAX_SIZE_LENGTH = 20;
const MAX_COLORS = 12;
const MAX_COLOR_LENGTH = 40;

// Los pares talle/color se arman en SQL con un separador de control (U+001F): ningún valor puede traer uno.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const collapseSpaces = (text) => text.replace(/\s+/g, ' ').trim();

const toList = (value) => {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.filter((item) => item !== '');
};

const canonicalize = (values) => {
  const byKey = new Map();
  for (const value of values.map(collapseSpaces).filter(Boolean)) {
    const key = value.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, value]) => value);
};

const multiValue = (name, maxItems, maxLength) => z.preprocess(
  toList,
  z.array(
    z.string().max(maxLength, `${name}: cada valor admite hasta ${maxLength} caracteres`)
      .refine((text) => !CONTROL_CHARS.test(text), `${name}: caracteres no permitidos`)
  ).max(maxItems, `${name}: admite hasta ${maxItems} valores`).optional()
).transform((values) => canonicalize(values ?? []));

const catalogQuerySchema = z.object({
  category: multiValue('category', MAX_CATEGORIES, MAX_CATEGORY_LENGTH),
  size: multiValue('size', MAX_SIZES, MAX_SIZE_LENGTH),
  color: multiValue('color', MAX_COLORS, MAX_COLOR_LENGTH),
  sort: optionalEnum(SORT_VALUES).transform((value) => value ?? DEFAULT_SORT),
  offset: integerParam('offset', 0, MAX_OFFSET, 0),
  limit: integerParam('limit', DEFAULT_LIMIT, MAX_LIMIT),
}).strict();

module.exports = { catalogQuerySchema, SORT_VALUES, DEFAULT_LIMIT, MAX_LIMIT, MAX_OFFSET };
