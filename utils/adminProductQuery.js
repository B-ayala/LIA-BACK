/**
 * SQL del listado admin de productos (`GET /api/products/admin/list`).
 *
 * Replica en el servidor lo que antes hacía el front sobre `mapAdminProductRow`:
 *  - nombre y categoría "limpios" (trim + colapso de espacios; categoría con 1ª letra en mayúscula);
 *  - stock efectivo = suma del stock por talle si el producto lo controla, si no la columna `stock`;
 *  - `status` NULL cuenta como `active`.
 * Todos los valores del usuario viajan como parámetros ($n); lo único que se concatena son
 * fragmentos fijos de este archivo elegidos de listas blancas.
 */

const { escapeLike, cleanTextSql, categoryKeySql, SIZE_STOCK_SQL, createBinder } = require('./productSqlFragments');

const LOW_STOCK_MAX = 5;

// Mismas columnas que lee hoy el front (ADMIN_LIST_COLUMNS en productService.ts).
const ADMIN_LIST_COLUMNS = [
  'id', 'name', 'price', 'original_price', 'transfer_price', 'stock', 'category', 'image_url', 'images',
  'description', 'discount', 'condition', 'free_shipping', 'hover_image_enabled', 'card_options', 'variants',
  'specifications', 'features', 'faqs', 'warranty', 'return_policy', 'size_guide', 'status', 'featured',
  'updated_at',
];

const NORMALIZED_CTE = `WITH normalized AS (
  SELECT ${ADMIN_LIST_COLUMNS.map((column) => `p.${column}`).join(', ')}, p.created_at,
         ${cleanTextSql('p.name')} AS name_key,
         ${categoryKeySql('p.category')} AS category_key,
         COALESCE(p.status, 'active') AS status_key,
         COALESCE(${SIZE_STOCK_SQL}, p.stock) AS effective_stock
    FROM public.productos p
)`;

const STOCK_PREDICATES = {
  in_stock: 'effective_stock > 0',
  low_stock: `effective_stock > 0 AND effective_stock <= ${LOW_STOCK_MAX}`,
  out_of_stock: 'effective_stock = 0',
};

// Orden por texto en "C" (code units, como el `<` de JS que usaba el front); los NULL siempre al final.
// Desempate fijo (más nuevo primero, luego id) para que la paginación sea estable.
const TIEBREAK = 'created_at DESC, id DESC';
const SORTS = {
  name_asc: `name_key COLLATE "C" ASC, ${TIEBREAK}`,
  name_desc: `name_key COLLATE "C" DESC, ${TIEBREAK}`,
  price_asc: `price ASC NULLS LAST, ${TIEBREAK}`,
  price_desc: `price DESC NULLS LAST, ${TIEBREAK}`,
  stock_asc: `effective_stock ASC NULLS LAST, ${TIEBREAK}`,
  stock_desc: `effective_stock DESC NULLS LAST, ${TIEBREAK}`,
  category_asc: `NULLIF(category_key, '') COLLATE "C" ASC NULLS LAST, ${TIEBREAK}`,
  category_desc: `NULLIF(category_key, '') COLLATE "C" DESC NULLS LAST, ${TIEBREAK}`,
};

/** Arma el WHERE con placeholders; devuelve `{ where, values }`. */
const buildWhere = ({ q, category, status, stock }) => {
  const clauses = [];
  const { values, bind } = createBinder();

  if (q) clauses.push(`name_key ILIKE ${bind(`%${escapeLike(q)}%`)} ESCAPE '\\'`);
  if (category) clauses.push(`category_key = ${bind(category)}`);
  if (status) clauses.push(`status_key = ${bind(status)}`);
  if (stock) clauses.push(STOCK_PREDICATES[stock]);

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', values };
};

/** Página de productos + total filtrado en una sola consulta (`COUNT(*) OVER()`). */
const buildPageQuery = (filters, { page, limit }) => {
  const { where, values } = buildWhere(filters);
  const order = SORTS[filters.sort] || TIEBREAK;
  values.push(limit, (page - 1) * limit);
  const text = `${NORMALIZED_CTE}
SELECT ${ADMIN_LIST_COLUMNS.join(', ')}, COUNT(*) OVER()::int AS total_count
  FROM normalized
  ${where}
 ORDER BY ${order}
 LIMIT $${values.length - 1} OFFSET $${values.length}`;
  return { text, values };
};

/** Total filtrado: solo se usa cuando la página pedida cae fuera de rango (sin filas no hay `COUNT OVER`). */
const buildCountQuery = (filters) => {
  const { where, values } = buildWhere(filters);
  return { text: `${NORMALIZED_CTE}\nSELECT COUNT(*)::int AS total FROM normalized ${where}`, values };
};

/** Categorías distintas SIN filtrar, ya normalizadas y en orden de code units (como `[...new Set()].sort()`). */
const buildCategoriesQuery = () => ({
  text: `${NORMALIZED_CTE}
SELECT category_key
  FROM (SELECT DISTINCT category_key FROM normalized WHERE category_key <> '') AS categories
 ORDER BY category_key COLLATE "C"`,
  values: [],
});

module.exports = {
  LOW_STOCK_MAX, ADMIN_LIST_COLUMNS, escapeLike, buildPageQuery, buildCountQuery, buildCategoriesQuery,
};
