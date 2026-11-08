/**
 * SQL del catálogo público (`GET /api/products/catalog`).
 *
 * Reglas (todas decididas en el servidor):
 *  - solo `status = 'active'` (igual que el filtro que hacía el front; un NULL no se publica);
 *  - categoría: igualdad sin distinguir mayúsculas sobre el texto limpio (trim + espacios colapsados);
 *  - precio de orden = precio que ve y paga el cliente (misma regla que `resolveUnitPrice`):
 *    `price` si hay `original_price` mayor (el tachado es solo la referencia), si no `price` con el
 *    `discount` porcentual aplicado y redondeado a centavos;
 *  - talle/color: cada producto se expande a "combinaciones disponibles" `TALLE<US>Color` (ver COMBOS_SQL).
 * Todo valor del usuario viaja como parámetro ($n); lo único que se concatena son fragmentos fijos
 * de este archivo elegidos de listas blancas.
 */

const { cleanTextSql, FIRST_SIZE_VARIANT_SQL, SIZE_STOCK_SQL, createBinder } = require('./productSqlFragments');

// Las 13 columnas que lee el front (mapDbRowToProduct). Los numéricos salen como número (no como
// string de `pg`), igual que los devolvía PostgREST.
const NUMERIC_COLUMNS = ['price', 'original_price', 'transfer_price', 'discount', 'stock'];
const CATALOG_COLUMNS = [
  'id', 'name', 'price', 'original_price', 'transfer_price', 'image_url', 'images', 'category', 'discount',
  'stock', 'hover_image_enabled', 'card_options', 'variants',
];
const OUTPUT_SELECT = CATALOG_COLUMNS
  .map((column) => (NUMERIC_COLUMNS.includes(column) ? `${column}::float8 AS ${column}` : column))
  .join(', ');

// Precio efectivo (ver cabecera). Se castea a numeric: el redondeo a centavos no existe para float.
const EFFECTIVE_PRICE_SQL = `(CASE
  WHEN p.original_price IS NOT NULL AND p.original_price > p.price THEN p.price
  WHEN COALESCE(p.discount, 0) > 0 THEN round(p.price::numeric * (1 - p.discount::numeric / 100), 2)
  ELSE p.price END)`;

// Nombre para ordenar: minúsculas y sin tildes, en orden de code units (independiente de la
// colación y del locale de la base: las acentuadas se pliegan a mano). La "ñ" se ordena como "n".
const NAME_SORT_SQL = `translate(lower(${cleanTextSql('p.name')}),
  'áàâäéèêëíìîïóòôöúùûüñÁÀÂÄÉÈÊËÍÌÎÏÓÒÔÖÚÙÛÜÑ', 'aaaaeeeeiiiioooouuuunaaaaeeeeiiiioooouuuun') COLLATE "C"`;

// Opciones de la variante "Color" (jsonb array de textos). Se usan para los talles sin colores propios.
const COLOR_OPTIONS_SQL = `COALESCE((
  SELECT jsonb_agg(co.opt)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.variants) = 'array' THEN p.variants ELSE '[]'::jsonb END) AS cv(item),
         jsonb_array_elements_text(CASE WHEN jsonb_typeof(cv.item->'options') = 'array' THEN cv.item->'options' ELSE '[]'::jsonb END) AS co(opt)
   WHERE jsonb_typeof(cv.item) = 'object' AND lower(btrim(cv.item->>'name')) = 'color'
), '[]'::jsonb)`;

const BASE_CTE = `base AS (
  SELECT p.id, p.name, p.price, p.original_price, p.transfer_price, p.image_url, p.images, p.category,
         p.discount, p.stock, p.hover_image_enabled, p.card_options, p.variants, p.created_at,
         lower(${cleanTextSql('p.category')}) AS category_match,
         ${NAME_SORT_SQL} AS name_sort,
         ${EFFECTIVE_PRICE_SQL} AS sort_price,
         ${SIZE_STOCK_SQL} AS size_stock,
         sv.v AS size_variant,
         ${COLOR_OPTIONS_SQL} AS color_options
    FROM public.productos p
    LEFT JOIN LATERAL (${FIRST_SIZE_VARIANT_SQL}) AS sv ON true
   WHERE p.status = 'active'
)`;

// Talles del producto y si hay stock de cada uno. Con stock por talle cargado manda `stockByOption`
// (una opción sin número = sin stock); si el producto NO lleva stock por talle (`size_stock` NULL)
// todos sus talles valen lo que la columna `stock`. Sin variante de talle queda un único talle ''.
const SIZE_ROWS_SQL = `SELECT size_key, bool_or(available) AS available
    FROM (
      SELECT upper(btrim(x)) AS size_key,
             CASE WHEN jsonb_typeof(b.size_variant->'stockByOption'->upper(btrim(x))) = 'number'
                  THEN (b.size_variant->'stockByOption'->>upper(btrim(x)))::numeric > 0
                  ELSE b.size_stock IS NULL AND COALESCE(b.stock, 0) > 0 END AS available
        FROM jsonb_array_elements_text(COALESCE(b.size_variant->'options', '[]'::jsonb)) AS x
       WHERE btrim(x) <> ''
      UNION ALL
      SELECT '', COALESCE(b.stock, 0) > 0 WHERE b.size_variant IS NULL
    ) AS raw
   GROUP BY size_key`;

// Colores de un talle: `colorsByOption[talle]` (en la variante de talle) si tiene alguno, si no las
// opciones de la variante Color. Siempre se suma '' para que filtrar solo por talle no dependa de los colores.
const SIZE_COLORS_PATH = "b.size_variant->'colorsByOption'->s.size_key";
const COLORS_FOR_SIZE_SQL = `SELECT '' AS color_name
      UNION
      SELECT ${cleanTextSql('x')}
        FROM jsonb_array_elements_text(CASE
               WHEN CASE WHEN jsonb_typeof(${SIZE_COLORS_PATH}) = 'array'
                         THEN jsonb_array_length(${SIZE_COLORS_PATH}) ELSE 0 END > 0
               THEN ${SIZE_COLORS_PATH} ELSE b.color_options END) AS x
       WHERE btrim(x) <> ''`;

// Combinaciones con stock: `TALLE` + chr(31) + `Color` ('' = sin color). El separador de control no
// puede venir en un filtro (lo rechaza el schema).
const COMBOS_SQL = `ARRAY(
    SELECT s.size_key || chr(31) || c.color_name
      FROM (${SIZE_ROWS_SQL}) AS s
     CROSS JOIN LATERAL (${COLORS_FOR_SIZE_SQL}) AS c
     WHERE s.available
  )`;

const SORTS = {
  newest: 'created_at DESC, id DESC',
  price_asc: 'sort_price ASC NULLS LAST, created_at DESC, id DESC',
  price_desc: 'sort_price DESC NULLS LAST, created_at DESC, id DESC',
  name_asc: 'name_sort ASC, created_at DESC, id DESC',
  name_desc: 'name_sort DESC, created_at DESC, id DESC',
};

const lowerList = (placeholder) => `ARRAY(SELECT lower(u) FROM unnest(${placeholder}::text[]) AS u)`;
const upperList = (placeholder) => `ARRAY(SELECT upper(btrim(u)) FROM unnest(${placeholder}::text[]) AS u)`;

/** CTEs `base` (activos) y `scoped` (filtrado SOLO por categoría, con sus combinaciones). */
const buildScopeCte = (categories, bind) => {
  const categoryWhere = categories.length > 0 ? `WHERE b.category_match = ANY(${lowerList(bind(categories))})` : '';
  return `WITH ${BASE_CTE},
scoped AS (
  SELECT b.*, ${COMBOS_SQL} AS combos
    FROM base b
   ${categoryWhere}
)`;
};

/** Talle y/o color sobre la MISMA combinación: "M y Rojo" exige M con stock disponible en Rojo. */
const buildComboWhere = ({ size, color }, bind) => {
  const conditions = [];
  if (size.length > 0) conditions.push(`split_part(c, chr(31), 1) = ANY(${upperList(bind(size))})`);
  if (color.length > 0) conditions.push(`lower(split_part(c, chr(31), 2)) = ANY(${lowerList(bind(color))})`);
  return conditions.length > 0 ? `WHERE EXISTS (SELECT 1 FROM unnest(combos) AS c WHERE ${conditions.join(' AND ')})` : '';
};

/** Página (pide `limit + 1` filas para saber si hay más sin un COUNT aparte). */
const buildCatalogPageQuery = ({ category, size, color, sort }, { offset, limit }) => {
  const { values, bind } = createBinder();
  const scope = buildScopeCte(category, bind);
  const where = buildComboWhere({ size, color }, bind);
  const text = `${scope}
SELECT ${OUTPUT_SELECT}
  FROM scoped
  ${where}
 ORDER BY ${SORTS[sort]}
 LIMIT ${bind(limit + 1)} OFFSET ${bind(offset)}`;
  return { text, values };
};

/** Talles y colores con stock del conjunto filtrado solo por categoría (para poblar los selectores). */
const buildCatalogFacetsQuery = ({ category }) => {
  const { values, bind } = createBinder();
  const scope = buildScopeCte(category, bind);
  const text = `${scope}
SELECT DISTINCT ON (kind, lower(value)) kind, value
  FROM (
    SELECT 'size' AS kind, split_part(c, chr(31), 1) AS value FROM scoped, unnest(combos) AS c
    UNION ALL
    SELECT 'color', split_part(c, chr(31), 2) FROM scoped, unnest(combos) AS c
  ) AS f
 WHERE value <> ''
 ORDER BY kind, lower(value), value COLLATE "C"`;
  return { text, values };
};

module.exports = { CATALOG_COLUMNS, buildCatalogPageQuery, buildCatalogFacetsQuery };
