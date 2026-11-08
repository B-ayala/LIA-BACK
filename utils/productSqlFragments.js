/**
 * Fragmentos SQL de `public.productos` compartidos por el listado admin y el catálogo público.
 * Todos son texto fijo (nada del usuario se concatena) y asumen el alias `p` de la tabla.
 */

const LIKE_SPECIAL_CHARS = /[\\%_]/g;

const escapeLike = (text) => text.replace(LIKE_SPECIAL_CHARS, '\\$&');

/** Texto "limpio": trim + espacios colapsados (como `cleanText`/`normalizeCategory` del front). */
const cleanTextSql = (column) => `btrim(regexp_replace(COALESCE(${column}, ''), '\\s+', ' ', 'g'))`;

/** Categoría normalizada: texto limpio con la 1ª letra en mayúscula. */
const categoryKeySql = (column) =>
  `upper(left(${cleanTextSql(column)}, 1)) || substr(${cleanTextSql(column)}, 2)`;

// Primera variante cuyo nombre empieza con "talle" y que tiene opciones (como getProductStockFromVariants).
// Una fila `(v jsonb)` o ninguna; correlacionada con `p.variants`.
const FIRST_SIZE_VARIANT_SQL = `SELECT t.v
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.variants) = 'array' THEN p.variants ELSE '[]'::jsonb END)
             WITH ORDINALITY AS t(v, ord)
       WHERE jsonb_typeof(t.v) = 'object'
         AND lower(btrim(t.v->>'name')) LIKE 'talle%'
         AND jsonb_typeof(t.v->'options') = 'array'
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.v->'options') AS x WHERE btrim(x) <> '')
       ORDER BY t.ord
       LIMIT 1`;

// Suma el stock por opción (mayúsculas, sin repetidas, mínimo 0). Sin ningún valor numérico → NULL
// → se usa la columna `stock`.
const SIZE_STOCK_SQL = `(
  SELECT SUM(GREATEST(0, CASE WHEN jsonb_typeof(sv.v->'stockByOption'->o.opt) = 'number'
                              THEN (sv.v->'stockByOption'->>o.opt)::numeric END))
    FROM (
      ${FIRST_SIZE_VARIANT_SQL}
    ) AS sv
    CROSS JOIN LATERAL (
      SELECT DISTINCT upper(btrim(x)) AS opt
        FROM jsonb_array_elements_text(sv.v->'options') AS x
       WHERE btrim(x) <> ''
    ) AS o
   WHERE jsonb_typeof(sv.v->'stockByOption'->o.opt) = 'number'
)`;

/** Acumulador de parámetros: `bind(valor)` lo agrega a `values` y devuelve su placeholder `$n`. */
const createBinder = () => {
  const values = [];
  const bind = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  return { values, bind };
};

module.exports = { createBinder, escapeLike, cleanTextSql, categoryKeySql, FIRST_SIZE_VARIANT_SQL, SIZE_STOCK_SQL };
