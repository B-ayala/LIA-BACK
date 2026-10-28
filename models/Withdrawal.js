const { pool } = require('../config/database');

// Tope de compras que se vinculan a una solicitud: el admin elige cuál corresponde.
const MAX_LINKED_PURCHASES = 20;

// Compras que cuentan para arrepentirse: las que no quedaron vencidas ni canceladas.
const ACTIVE_PURCHASE_FILTER = "payment_status NOT IN ('expirado', 'cancelado')";

const LIST_COLUMNS = `w.id, w.code, w.name, w.email, w.description, w.order_number::int AS order_number,
       w.purchase_date, w.purchase_amount::float8 AS purchase_amount, w.status, w.needs_review, w.admin_note, w.created_at, w.updated_at, w.resolved_at`;

const LINKED_PURCHASES = `COALESCE((
         SELECT json_agg(json_build_object(
                  'id', v.id, 'order_number', v.order_number::int,
                  'product_name', v.product_name, 'total_price', v.total_price::float8
                ) ORDER BY v.created_at)
           FROM public.ventas v WHERE v.id = ANY(w.venta_ids)
       ), '[]'::json) AS purchases`;

/** Acceso a datos de las solicitudes de arrepentimiento (tabla public.withdrawal_requests). */
class Withdrawal {
  /**
   * Compras del email a vincular con la solicitud. Si el cliente dio pedido y/o fecha se busca primero
   * con esos filtros; si no hay coincidencia exacta se cae al email solo, así el admin ve candidatas.
   * @returns {Promise<{ids: string[], exact: boolean}>} `exact` es false si faltó algún dato o no coincidió.
   */
  static async findPurchaseIds(email, { orderNumber, purchaseDate } = {}) {
    const hasFilters = orderNumber !== undefined || purchaseDate !== undefined;
    if (hasFilters) {
      const strict = await Withdrawal.queryPurchases(email, orderNumber, purchaseDate);
      if (strict.length > 0) return { ids: strict, exact: true };
    }
    return { ids: await Withdrawal.queryPurchases(email, undefined, undefined), exact: false };
  }

  // La fecha se compara en hora argentina con ±1 día de margen (el cliente puede recordarla mal).
  static async queryPurchases(email, orderNumber, purchaseDate) {
    const result = await pool.query(
      `SELECT id FROM public.ventas
        WHERE LOWER(buyer_email) = $1 AND ${ACTIVE_PURCHASE_FILTER}
          AND ($2::int IS NULL OR order_number = $2::int)
          AND ($3::date IS NULL
               OR (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
                  BETWEEN $3::date - 1 AND $3::date + 1)
        ORDER BY created_at DESC
        LIMIT $4`,
      [email, orderNumber ?? null, purchaseDate ?? null, MAX_LINKED_PURCHASES]
    );
    return result.rows.map((row) => row.id);
  }

  /** El código `ARR-AAAA-NNNN` lo genera la base (default sobre su secuencia). */
  static async create({ name, email, description, orderNumber, purchaseDate, purchaseAmount, ventaIds, needsReview }) {
    const result = await pool.query(
      `INSERT INTO public.withdrawal_requests
         (name, email, description, order_number, purchase_date, purchase_amount, venta_ids, needs_review)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8)
       RETURNING code, created_at`,
      [name, email, description, orderNumber ?? null, purchaseDate ?? null, purchaseAmount ?? null, ventaIds, needsReview]
    );
    return { code: result.rows[0].code, createdAt: result.rows[0].created_at };
  }

  /** @returns {Promise<{rows: object[], total: number}>} */
  static async findPage({ status, limit, offset }) {
    const result = await pool.query(
      `SELECT ${LIST_COLUMNS}, ${LINKED_PURCHASES}, COUNT(*) OVER()::int AS total_count
         FROM public.withdrawal_requests w
        WHERE ($1::text IS NULL OR w.status = $1)
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT $2 OFFSET $3`,
      [status ?? null, limit, offset]
    );
    const total = result.rows.length > 0 ? result.rows[0].total_count : 0;
    return { rows: result.rows.map(({ total_count, ...row }) => row), total };
  }

  /**
   * Cambia estado y/o nota. `resolved_at` se fija al resolver o rechazar y se limpia
   * si la solicitud se reabre; sin cambio de estado no se toca.
   * @returns {Promise<object|null>} la solicitud actualizada, o null si no existe.
   */
  static async update(id, { status, adminNote }) {
    const result = await pool.query(
      `UPDATE public.withdrawal_requests w
          SET status = COALESCE($2, w.status),
              admin_note = CASE WHEN $3::boolean THEN $4 ELSE w.admin_note END,
              resolved_at = CASE WHEN $2 IN ('resuelta', 'rechazada') THEN now()
                                 WHEN $2 IN ('recibida', 'en_gestion') THEN NULL
                                 ELSE w.resolved_at END
        WHERE w.id = $1::uuid
        RETURNING ${LIST_COLUMNS}, ${LINKED_PURCHASES}`,
      [id, status ?? null, adminNote !== undefined, adminNote ?? null]
    );
    return result.rows[0] || null;
  }
}

module.exports = Withdrawal;
