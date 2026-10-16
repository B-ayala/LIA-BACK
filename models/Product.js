const { pool } = require('../config/database');
const { withTransaction, rollbackWith } = require('../utils/transaction');
const { buildProductAssignments, buildProductUpdateStatement } = require('../utils/productUpdateQuery');

/** Acceso a datos de productos (tabla public.productos) para el CRUD de admin y el catálogo. */
class Product {
  static async create(fields) {
    const result = await pool.query(
      `INSERT INTO public.productos
       (name, price, stock, category, image_url, public_id, description,
        discount, condition, free_shipping, hover_image_enabled, variants, specifications, features, faqs,
        warranty, return_policy, size_guide, status, images, original_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       RETURNING *`,
      fields
    );
    return result.rows[0];
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
  static async update(id, body, expectedUpdatedAt) {
    const assignments = buildProductAssignments(body);
    if (assignments.length === 0) return { status: 'empty' };

    const statement = buildProductUpdateStatement(id, assignments, expectedUpdatedAt);
    const result = await pool.query(statement.text, statement.values);
    if (result.rows[0]) return { status: 'updated', product: result.rows[0] };
    if (!expectedUpdatedAt) return { status: 'not_found' };

    const exists = await pool.query('SELECT 1 FROM public.productos WHERE id = $1', [id]);
    return { status: exists.rowCount > 0 ? 'changed' : 'not_found' };
  }

  /**
   * Borra el producto si no tiene ventas `pendiente` (su stock está reservado y
   * borrarlo dejaría la orden sin mercadería). Bloquea la fila del producto: una
   * reserva concurrente (que también la bloquea) no puede colarse entre el chequeo
   * y el DELETE.
   * @returns {Promise<{status: 'not_found'|'has_pending_orders'} |
   *   {status: 'deleted', publicId: string|null, imageShared: boolean}>}
   */
  static async deleteIfNoPendingOrders(id) {
    return withTransaction('delete_product', async (client) => {
      const product = await client.query('SELECT public_id FROM public.productos WHERE id = $1 FOR UPDATE', [id]);
      if (product.rowCount === 0) return rollbackWith({ status: 'not_found' });

      const pending = await client.query(
        "SELECT 1 FROM public.ventas WHERE product_id = $1 AND payment_status = 'pendiente' LIMIT 1",
        [id]
      );
      if (pending.rowCount > 0) return rollbackWith({ status: 'has_pending_orders' });

      const publicId = product.rows[0].public_id || null;
      const shared = publicId
        ? await client.query('SELECT 1 FROM public.productos WHERE id <> $1 AND public_id = $2 LIMIT 1', [id, publicId])
        : { rowCount: 0 };
      await client.query('DELETE FROM public.productos WHERE id = $1', [id]);
      return { status: 'deleted', publicId, imageShared: shared.rowCount > 0 };
    });
  }
}

module.exports = Product;
