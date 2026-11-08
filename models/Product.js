const { pool } = require('../config/database');
const { withTransaction, rollbackWith } = require('../utils/transaction');
const { buildProductAssignments, buildProductUpdateStatement } = require('../utils/productUpdateQuery');
const { findMissingForActive } = require('../utils/productPublishing');
const { buildPageQuery, buildCountQuery, buildCategoriesQuery } = require('../utils/adminProductQuery');
const { buildCatalogPageQuery, buildCatalogFacetsQuery } = require('../utils/catalogProductQuery');
const { buildFacets } = require('../utils/catalogFacets');

/**
 * Se valida la fila YA escrita (RETURNING *) y no el body: un update parcial que no menciona
 * fotos o talles igual tiene que dejar completo un producto activo. Si no, se deshace.
 */
const rollbackIfIncomplete = (product) => {
  const missing = findMissingForActive(product);
  return missing ? rollbackWith({ status: 'incomplete', missing }) : null;
};

/**
 * ¿Otra fila referencia este `public_id`? Productos por columna; carrusel y contenido del
 * sitio guardan URLs (a veces dentro de jsonb, a veces con el id percent-encoded), así que
 * se busca el id como substring de la fila serializada. Un falso positivo solo deja un
 * asset huérfano; un falso negativo rompería una imagen publicada.
 */
const isImageInUse = async (client, productId, publicId) => {
  const result = await client.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM public.productos WHERE id <> $1 AND public_id = $2)
        OR EXISTS (SELECT 1 FROM public.carousel_images c
                    WHERE position($2 IN to_jsonb(c)::text) > 0 OR position($3 IN to_jsonb(c)::text) > 0)
        OR EXISTS (SELECT 1 FROM public.site_content s
                    WHERE position($2 IN to_jsonb(s)::text) > 0 OR position($3 IN to_jsonb(s)::text) > 0)`,
    [productId, publicId, encodeURI(publicId)]
  );
  return result.rowCount > 0;
};

/** Acceso a datos de productos (tabla public.productos) para el CRUD de admin y el catálogo. */
class Product {
  /**
   * `actor`: uuid del admin que crea el producto (queda en audit_log.actor).
   * @returns {Promise<{status: 'created', product: object} | {status: 'incomplete', missing: string}>}
   */
  static async create(fields, actor) {
    return withTransaction('create_product', async (client) => {
      const result = await client.query(
        `INSERT INTO public.productos
         (name, price, stock, category, image_url, public_id, description,
          discount, condition, free_shipping, hover_image_enabled, variants, specifications, features, faqs,
          warranty, return_policy, size_guide, status, images, original_price, card_options, transfer_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING *`,
        fields
      );
      const product = result.rows[0];
      return rollbackIfIncomplete(product) || { status: 'created', product };
    }, { actor });
  }

  /**
   * Página del catálogo en UNA sola consulta (`COUNT(*) OVER()` trae el total).
   * Sin `includeInactive` solo salen los activos (`status` NULL cuenta como activo):
   * solo un admin ve el resto.
   * @returns {Promise<{rows: object[], total: number}>}
   */
  static async findPage(limit, offset, includeInactive = false) {
    // Fragmento fijo (sin input del usuario).
    const where = includeInactive ? '' : "WHERE COALESCE(status, 'active') = 'active'";
    const result = await pool.query(
      `SELECT *, COUNT(*) OVER()::int AS total_count
         FROM public.productos
         ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const rows = result.rows.map(({ total_count, ...product }) => product);
    if (rows.length > 0) return { rows, total: result.rows[0].total_count };

    // Página vacía (offset fuera de rango): el total se resuelve aparte.
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM public.productos ${where}`);
    return { rows, total: countResult.rows[0].total };
  }

  /**
   * Listado del panel admin: filtra, ordena y pagina en la base (incluye inactivos).
   * Página y categorías corren EN SERIE: un slot del carril admin usa una sola conexión del pool a la vez
   * (ver `concurrencyLimit`). Solo si la página cae fuera de rango se pide el total aparte.
   * @param {{q?: string, category?: string, status?: string, stock?: string, sort?: string}} filters
   * @returns {Promise<{rows: object[], total: number, categories: string[]}>}
   */
  static async findAdminPage(filters, { page, limit }) {
    const run = ({ text, values }) => pool.query(text, values);
    const pageResult = await run(buildPageQuery(filters, { page, limit }));
    const categoriesResult = await run(buildCategoriesQuery());
    const categories = categoriesResult.rows.map((row) => row.category_key);
    const rows = pageResult.rows.map(({ total_count, ...product }) => product);
    if (rows.length > 0) return { rows, total: pageResult.rows[0].total_count, categories };

    const countResult = await run(buildCountQuery(filters));
    return { rows, total: countResult.rows[0].total, categories };
  }

  /**
   * Página del catálogo público (solo activos): filtra, ordena y pagina en la base. Pide `limit + 1`
   * filas para saber si hay más sin un COUNT.
   * @param {{category: string[], size: string[], color: string[], sort: string}} filters
   * @returns {Promise<{items: object[], hasMore: boolean}>}
   */
  static async findCatalogItems(filters, { offset, limit }) {
    const { text, values } = buildCatalogPageQuery(filters, { offset, limit });
    const result = await pool.query(text, values);
    return { items: result.rows.slice(0, limit), hasMore: result.rows.length > limit };
  }

  /**
   * Talles y colores con stock del conjunto filtrado SOLO por categoría (no dependen de la página ni de
   * talle/color/orden), por eso el controller los cachea aparte.
   * @returns {Promise<{sizes: string[], colors: string[]}>}
   */
  static async findCatalogFacets(filters) {
    const { text, values } = buildCatalogFacetsQuery(filters);
    const result = await pool.query(text, values);
    return buildFacets(result.rows);
  }

  /** Página + facets EN SERIE (una conexión a la vez); el endpoint los pide por separado para cachearlos distinto. */
  static async findCatalogPage(filters, paging) {
    const page = await Product.findCatalogItems(filters, paging);
    return { ...page, facets: await Product.findCatalogFacets(filters) };
  }

  static async findById(id, includeInactive = false) {
    const activeOnly = includeInactive ? '' : "AND COALESCE(status, 'active') = 'active'";
    const result = await pool.query(`SELECT * FROM public.productos WHERE id = $1 ${activeOnly}`, [id]);
    return result.rows[0] || null;
  }

  /**
   * UPDATE parcial con control optimista opcional.
   * @returns {Promise<{status: 'updated', product: object} | {status: 'incomplete', missing: string}
   *   | {status: 'empty'|'not_found'|'changed'}>}
   */
  static async update(id, body, expectedUpdatedAt, actor) {
    const assignments = buildProductAssignments(body);
    if (assignments.length === 0) return { status: 'empty' };

    const statement = buildProductUpdateStatement(id, assignments, expectedUpdatedAt);
    return withTransaction('update_product', async (client) => {
      const result = await client.query(statement.text, statement.values);
      const product = result.rows[0];
      if (product) return rollbackIfIncomplete(product) || { status: 'updated', product };
      if (!expectedUpdatedAt) return { status: 'not_found' };

      const exists = await client.query('SELECT 1 FROM public.productos WHERE id = $1', [id]);
      return { status: exists.rowCount > 0 ? 'changed' : 'not_found' };
    }, { actor });
  }

  /**
   * Borra el producto si no tiene ventas `pendiente` (su stock está reservado y
   * borrarlo dejaría la orden sin mercadería). Bloquea la fila del producto: una
   * reserva concurrente (que también la bloquea) no puede colarse entre el chequeo
   * y el DELETE.
   * @returns {Promise<{status: 'not_found'|'has_pending_orders'} |
   *   {status: 'deleted', publicId: string|null, imageInUse: boolean}>}
   */
  static async deleteIfNoPendingOrders(id, actor) {
    return withTransaction('delete_product', async (client) => {
      const product = await client.query('SELECT public_id FROM public.productos WHERE id = $1 FOR UPDATE', [id]);
      if (product.rowCount === 0) return rollbackWith({ status: 'not_found' });

      const pending = await client.query(
        "SELECT 1 FROM public.ventas WHERE product_id = $1 AND payment_status = 'pendiente' LIMIT 1",
        [id]
      );
      if (pending.rowCount > 0) return rollbackWith({ status: 'has_pending_orders' });

      const publicId = product.rows[0].public_id || null;
      const imageInUse = publicId ? await isImageInUse(client, id, publicId) : false;
      await client.query('DELETE FROM public.productos WHERE id = $1', [id]);
      return { status: 'deleted', publicId, imageInUse };
    }, { actor });
  }
}

module.exports = Product;
