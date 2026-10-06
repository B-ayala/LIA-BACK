const { pool } = require('../config/database');

/**
 * Acceso a datos de analítica para el panel de administración.
 *
 * Solo lectura: ninguna de estas consultas muta estado. Todas usan queries
 * parametrizadas (sin concatenación) y se ejecutan detrás de authMiddleware +
 * adminMiddleware (ver routes/insightsRoutes.js).
 *
 * Zona horaria: los cortes de "hoy" / "este mes" se calculan en hora local de
 * Argentina, no en UTC, para que coincidan con lo que ve la administradora.
 * `created_at` es timestamptz (default now() de Supabase), por eso convertir con
 * `AT TIME ZONE` da el instante local correcto.
 */
const APP_TIMEZONE = 'America/Argentina/Buenos_Aires';
// Rango sargable sobre created_at (permite usar idx_ventas_paid_created); constante interna, sin input de usuario.
const TODAY_START_SQL = "(date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)";

// Canal de origen del pedido. Hoy "transferencia" implica que el cliente pasó por
// WhatsApp (el checkout abre wa.me con el pedido), así que es nuestro proxy de canal.
const WHATSAPP_PAYMENT_METHOD = 'transfer';
// Valor real de shipping_method para retiro en local (ver checkout y utils/labels
// del front). Los envíos a domicilio (moto/correo) quedan fuera de esta release.
const PICKUP_SHIPPING_METHOD = 'local';
// dispatch_status: 'pendiente' | 'en_preparacion' | 'despachado' | 'listo_para_retiro' | 'entregado'.
// Un retiro en local sigue pendiente de entrega mientras no esté entregado (o NULL).
const PENDING_PICKUP_STATUSES = ['pendiente', 'en_preparacion', 'listo_para_retiro'];

class Insights {
  /**
   * Productos ACTIVOS con stock por debajo del umbral, los más críticos primero.
   * Los inactivos no se venden, así que su stock bajo es ruido para la reposición.
   * `status` NULL se trata como activo (misma semántica que productController).
   */
  static async lowStock(threshold, limit) {
    const { rows } = await pool.query(
      `SELECT id, name, stock::int AS stock, price::float8 AS price,
              category, image_url
         FROM public.productos
        WHERE stock < $1
          AND COALESCE(status, 'active') = 'active'
        ORDER BY stock ASC, name ASC
        LIMIT $2`,
      [threshold, limit]
    );
    return rows;
  }

  /** Resumen de ventas pagadas del día (hora local) + ítems pagados hoy. */
  static async salesToday(limit) {
    const { rows: summaryRows } = await pool.query(
      `SELECT
          COALESCE(SUM(unit_price * quantity), 0)::float8 AS revenue,
          COALESCE(SUM(total_price), 0)::float8          AS revenue_with_shipping,
          COALESCE(SUM(quantity), 0)::int                AS units,
          COUNT(*)::int                                  AS line_items,
          COUNT(DISTINCT buyer_email || '|' ||
            to_char(date_trunc('minute', created_at), 'YYYYMMDDHH24MI'))::int AS orders
         FROM public.ventas
        WHERE payment_status = 'pagado'
          AND created_at >= ${TODAY_START_SQL}
          AND created_at <  ${TODAY_START_SQL} + interval '1 day'`,
      [APP_TIMEZONE]
    );

    const { rows: itemRows } = await pool.query(
      `SELECT id, buyer_name, buyer_email, product_name, quantity::int AS quantity,
              total_price::float8 AS total_price, payment_method, created_at
         FROM public.ventas
        WHERE payment_status = 'pagado'
          AND created_at >= ${TODAY_START_SQL}
          AND created_at <  ${TODAY_START_SQL} + interval '1 day'
        ORDER BY created_at DESC
        LIMIT $2`,
      [APP_TIMEZONE, limit]
    );

    return { summary: summaryRows[0], items: itemRows };
  }

  /** Pedidos pendientes de pago (cualquier método/modalidad), los más viejos primero. */
  static async pendingPayment(limit) {
    const { rows } = await pool.query(
      `SELECT id, buyer_name, buyer_email, product_name, quantity::int AS quantity,
              total_price::float8 AS total_price, payment_method, shipping_method,
              origin, created_at,
              EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
         FROM public.ventas
        WHERE payment_status = 'pendiente'
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit]
    );
    return rows;
  }

  /**
   * Compras de retiro en local que llegaron por WhatsApp (transferencia) y siguen
   * pendientes de confirmar, desde el momento en que se generó el pedido. El sweep
   * del backend las expira a las 5 h, así que acá aparecen las accionables.
   */
  static async pendingPickups(limit) {
    const { rows } = await pool.query(
      `SELECT id, buyer_name, buyer_email, product_name, quantity::int AS quantity,
              total_price::float8 AS total_price, origin, created_at,
              EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
         FROM public.ventas
        WHERE payment_status = 'pendiente'
          AND shipping_method = $1
          AND payment_method  = $2
        ORDER BY created_at ASC
        LIMIT $3`,
      [PICKUP_SHIPPING_METHOD, WHATSAPP_PAYMENT_METHOD, limit]
    );
    return rows;
  }

  /**
   * Top de productos por unidades vendidas (pagadas) en el mes local en curso,
   * con la facturación generada y la comparación contra el mismo top del mes anterior.
   * La facturación usa unit_price * quantity para no contaminar con el costo de envío.
   */
  static async topProducts(limit) {
    const { rows } = await pool.query(
      `WITH bounds AS (
         SELECT
           date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1                       AS month_start,
           (date_trunc('month', now() AT TIME ZONE $1) - interval '1 month') AT TIME ZONE $1 AS prev_start
       ),
       this_month AS (
         SELECT product_id, MAX(product_name) AS product_name,
                SUM(quantity)::int AS qty,
                SUM(unit_price * quantity)::float8 AS revenue
           FROM public.ventas, bounds
          WHERE payment_status = 'pagado'
            AND created_at >= bounds.month_start
          GROUP BY product_id
       ),
       prev_month AS (
         SELECT product_id, SUM(quantity)::int AS qty
           FROM public.ventas, bounds
          WHERE payment_status = 'pagado'
            AND created_at >= bounds.prev_start
            AND created_at <  bounds.month_start
          GROUP BY product_id
       )
       SELECT t.product_id, t.product_name, t.qty, t.revenue,
              COALESCE(p.qty, 0) AS prev_qty
         FROM this_month t
         LEFT JOIN prev_month p ON p.product_id = t.product_id
        ORDER BY t.qty DESC, t.revenue DESC
        LIMIT $2`,
      [APP_TIMEZONE, limit]
    );
    return rows;
  }

  /**
   * Productos con mayor crecimiento de unidades vendidas (pagadas) respecto del mes
   * anterior. Solo los que crecieron (growth > 0); `prev_qty = 0` se marca como nuevo.
   */
  static async salesGrowth(limit) {
    const { rows } = await pool.query(
      `WITH bounds AS (
         SELECT date_trunc('month', now() AT TIME ZONE $1) AT TIME ZONE $1                       AS month_start,
                (date_trunc('month', now() AT TIME ZONE $1) - interval '1 month') AT TIME ZONE $1 AS prev_start
       ),
       this_month AS (
         SELECT product_id, MAX(product_name) AS product_name, SUM(quantity)::int AS qty
           FROM public.ventas, bounds
          WHERE payment_status = 'pagado' AND created_at >= bounds.month_start
          GROUP BY product_id
       ),
       prev_month AS (
         SELECT product_id, SUM(quantity)::int AS qty
           FROM public.ventas, bounds
          WHERE payment_status = 'pagado'
            AND created_at >= bounds.prev_start AND created_at < bounds.month_start
          GROUP BY product_id
       )
       SELECT t.product_id, t.product_name, t.qty,
              COALESCE(p.qty, 0) AS prev_qty,
              (t.qty - COALESCE(p.qty, 0)) AS growth
         FROM this_month t
         LEFT JOIN prev_month p ON p.product_id = t.product_id
        WHERE (t.qty - COALESCE(p.qty, 0)) > 0
        ORDER BY growth DESC, t.qty DESC
        LIMIT $2`,
      [APP_TIMEZONE, limit]
    );
    return rows;
  }

  /** Retiros en local ya pagados, pendientes de confirmar la entrega (despacho). */
  static async pickupsToConfirm(limit) {
    const { rows } = await pool.query(
      `SELECT id, buyer_name, buyer_email, product_name, quantity::int AS quantity,
              total_price::float8 AS total_price, dispatch_status, created_at,
              EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
         FROM public.ventas
        WHERE payment_status = 'pagado'
          AND shipping_method = $1
          AND (dispatch_status IS NULL OR dispatch_status = ANY($2))
        ORDER BY created_at ASC
        LIMIT $3`,
      [PICKUP_SHIPPING_METHOD, PENDING_PICKUP_STATUSES, limit]
    );
    return rows;
  }
}

module.exports = Insights;
