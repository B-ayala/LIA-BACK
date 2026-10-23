const { pool } = require('../config/database');
const { withTransaction, rollbackWith } = require('../utils/transaction');
const { buildProductAssignments, buildProductUpdateStatement } = require('../utils/productUpdateQuery');

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
  /** `actor`: uuid del admin que crea el producto (queda en audit_log.actor). */
  static async create(fields, actor) {
    return withTransaction('create_product', async (client) => {
      const result = await client.query(
        `INSERT INTO public.productos
         (name, price, stock, category, image_url, public_id, description,
          discount, condition, free_shipping, hover_image_enabled, variants, specifications, features, faqs,
          warranty, return_policy, size_guide, status, images, original_price, card_options)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         RETURNING *`,
        fields
      );
      return result.rows[0];
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

  static async findById(id, includeInactive = false) {
    const activeOnly = includeInactive ? '' : "AND COALESCE(status, 'active') = 'active'";
    const result = await pool.query(`SELECT * FROM public.productos WHERE id = $1 ${activeOnly}`, [id]);
    return result.rows[0] || null;
  }

  /**
   * UPDATE parcial con control optimista opcional.
   * @returns {Promise<{status: 'updated', product: object} | {status: 'empty'|'not_found'|'changed'}>}
   */
  static async update(id, body, expectedUpdatedAt, actor) {
    const assignments = buildProductAssignments(body);
    if (assignments.length === 0) return { status: 'empty' };

    const statement = buildProductUpdateStatement(id, assignments, expectedUpdatedAt);
    return withTransaction('update_product', async (client) => {
      const result = await client.query(statement.text, statement.values);
      if (result.rows[0]) return { status: 'updated', product: result.rows[0] };
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
