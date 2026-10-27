const { pool } = require('../config/database');
const { withTransaction } = require('../utils/transaction');
const { RESTORE, applySizeDelta } = require('../utils/variantStock');

/**
 * Acceso a datos de órdenes (tabla public.ventas) y stock (public.productos).
 * Los métodos que reciben `client` participan de una transacción abierta por el
 * caller; los demás manejan su propia conexión. Lo relativo a cobros de Mercado
 * Pago (saldar, conciliar, marcar para revisión) vive en models/OrderPayment.js.
 *
 * Los ids de venta son uuid y se comparan como tal (`$1::uuid`): el borde ya
 * rechazó los que no lo son, así que nunca llega un 22P02 desde acá.
 *
 * Orden de bloqueo (evita deadlocks entre reserva, pago, cancelación y sweep):
 * filas de `ventas` por `id` ascendente; filas de `productos` por `id` ascendente.
 */

const byProductId = (a, b) => (Number(a.product_id) || 0) - (Number(b.product_id) || 0);

class Order {
  /**
   * Compras de un usuario para "Mis compras", más recientes primero, paginadas: las pagadas
   * más las transferencias cuyo comprador avisó que ya envió el comprobante (`origin =
   * 'wa_confirmado'`), en el estado que tengan (pendiente de verificación, pagada, cancelada o
   * expirada) para que vea cuándo las resuelve el admin. El total viaja en la misma consulta
   * (`COUNT(*) OVER()`).
   * @returns {Promise<{rows: object[], total: number}>}
   */
  static async findPurchasesByEmail(email, limit, offset) {
    const result = await pool.query(
      `SELECT id, user_id, buyer_name, buyer_email, product_id, product_name,
              product_image, quantity, unit_price, total_price, units_config,
              payment_method, payment_status, shipping_method, dispatch_status,
              mp_preference_id, origin, created_at, paid_at, dispatched_at, order_number::int AS order_number,
              COUNT(*) OVER()::int AS total_count
         FROM public.ventas
        WHERE LOWER(buyer_email) = LOWER($1)
          AND (payment_status = 'pagado'
               OR (payment_method = 'transfer' AND origin = 'wa_confirmado'))
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [email, limit, offset]
    );

    const rows = result.rows.map(({ total_count, ...order }) => order);
    return { rows, total: rows.length > 0 ? result.rows[0].total_count : 0 };
  }

  /** Lectura sin bloqueo (para decidir antes de abrir una transacción). */
  static async findById(id) {
    const result = await pool.query('SELECT * FROM public.ventas WHERE id = $1::uuid', [id]);
    return result.rows[0] || null;
  }

  /** Lectura sin bloqueo de varias ventas (ids inexistentes simplemente no vuelven). */
  static async findByIds(ids) {
    const result = await pool.query('SELECT * FROM public.ventas WHERE id = ANY($1::uuid[])', [ids]);
    return result.rows;
  }

  /** Bloquea la fila de la orden para actualizarla dentro de una transacción. */
  static async findByIdForUpdate(client, id) {
    const result = await client.query('SELECT * FROM public.ventas WHERE id = $1::uuid FOR UPDATE', [id]);
    return result.rows[0] || null;
  }

  /** Bloquea varias ventas en orden de `id` (orden de bloqueo común a todo el módulo). */
  static async findByIdsForUpdate(client, ids) {
    const result = await client.query(
      'SELECT * FROM public.ventas WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [ids]
    );
    return result.rows;
  }

  /**
   * Bloquea la fila del producto y devuelve lo necesario para venderlo: stock,
   * variantes, precio, nombre e imagen vigentes. Nombre, imagen y precio de la
   * venta salen de acá y NO del body. La imagen es la primera de `images` (jsonb)
   * o, si no hay, `image_url` (mismo criterio que el alta de productos).
   * @returns {Promise<object|null>} fila del producto, o null si no existe.
   */
  static async getProductForUpdate(client, productId) {
    const result = await client.query(
      `SELECT stock, variants, name, status,
              COALESCE(NULLIF(images->>0, ''), NULLIF(image_url, '')) AS image,
              price::float8 AS price, discount::float8 AS discount,
              original_price::float8 AS original_price
         FROM public.productos
        WHERE id = $1
          FOR UPDATE`,
      [productId]
    );
    return result.rows[0] || null;
  }

  /**
   * Líneas y unidades de venta pendientes (stock reservado y sin pagar) de un usuario.
   * Acota cuánto stock puede retener una sola cuenta sin comprar.
   * @returns {Promise<{lines: number, units: number}>}
   */
  static async countPendingByUser(client, userId) {
    const result = await client.query(
      `SELECT COUNT(*)::int AS pending, COALESCE(SUM(quantity), 0)::int AS units
         FROM public.ventas WHERE user_id = $1::uuid AND payment_status = 'pendiente'`,
      [String(userId)]
    );
    const row = result.rows[0];
    return { lines: row.pending, units: Number(row.units) || 0 };
  }

  /** Guarda el desglose de stock por talle (la fila del producto ya está bloqueada por el caller). */
  static async setVariants(client, productId, variants) {
    await client.query(
      'UPDATE public.productos SET variants = $2::jsonb, updated_at = NOW() WHERE id = $1',
      [productId, JSON.stringify(variants)]
    );
  }

  /**
   * Devuelve stock previamente descontado (cancelación / expiración de una orden),
   * tanto el total como el talle de cada unidad (`unitsConfig` de la venta).
   */
  static async restoreStock(client, productId, quantity, unitsConfig = []) {
    if (productId == null) return;
    const result = await client.query(
      `UPDATE public.productos SET stock = stock + $2, updated_at = NOW()
        WHERE id = $1 RETURNING variants`,
      [productId, quantity]
    );
    const product = result.rows[0];
    const nextVariants = product ? applySizeDelta(product.variants, unitsConfig, RESTORE) : null;
    if (nextVariants) await Order.setVariants(client, productId, nextVariants);
  }

  /** Devuelve el stock de varias ventas, bloqueando productos en orden ascendente. */
  static async restoreStockForRows(client, rows) {
    for (const row of [...rows].sort(byProductId)) {
      await Order.restoreStock(client, row.product_id, row.quantity, row.units_config);
    }
  }

  /** Número de pedido nuevo: se pide UNA vez por checkout y lo comparten todas sus líneas. */
  static async nextOrderNumber(client) {
    const result = await client.query("SELECT nextval('public.ventas_order_number_seq')::int AS order_number");
    return result.rows[0].order_number;
  }

  /** Inserta una línea de venta pendiente y devuelve su id. */
  static async insertPending(client, row) {
    const result = await client.query(
      `INSERT INTO public.ventas
        (buyer_name, buyer_email, user_id, product_id, product_name, product_image,
         quantity, unit_price, total_price, units_config,
         payment_method, payment_status, shipping_method, mp_external_reference, order_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pendiente', $12, $13, $14)
       RETURNING id`,
      [
        row.buyerName || null,
        row.buyerEmail || null,
        row.userId || null,
        row.productId,
        row.productName,
        row.productImage || null,
        row.quantity,
        row.unitPrice,
        row.totalPrice,
        JSON.stringify(row.unitsConfig || []),
        row.paymentMethod,
        row.shippingMethod || null,
        row.mpExternalReference || null,
        row.orderNumber ?? null,
      ]
    );
    return result.rows[0].id;
  }

  static async setStatus(client, id, status) {
    await client.query('UPDATE public.ventas SET payment_status = $2 WHERE id = $1::uuid', [id, status]);
  }

  /** Registra la respuesta del nudge post-WhatsApp ('origin') de una orden. */
  static async setOrigin(client, id, origin) {
    await client.query('UPDATE public.ventas SET origin = $2 WHERE id = $1::uuid', [id, origin]);
  }

  /** Cancela ventas `pendiente` ya bloqueadas por el caller y devuelve su stock. */
  static async cancelLockedPending(client, rows) {
    const pending = rows.filter((row) => row.payment_status === 'pendiente');
    for (const row of pending) await Order.setStatus(client, row.id, 'cancelado');
    await Order.restoreStockForRows(client, pending);
    return pending.length;
  }

  /**
   * Órdenes de MP pendientes cuyo plazo venció, las más viejas primero (candidatas a expirar).
   * `skipReferences`: compras ya consultadas hace poco y retenidas. Sin excluirlas, las
   * `limit` más viejas serían siempre las mismas retenidas (pago en curso, MP caído) y las
   * vencidas más nuevas nunca llegarían a evaluarse (stock acaparado de más).
   */
  static async findStaleMpOrders(mpExpiryMinutes, limit, skipReferences = []) {
    const result = await pool.query(
      `SELECT id, mp_external_reference, review_reason, created_at
         FROM public.ventas
        WHERE payment_method = 'mp' AND payment_status = 'pendiente'
          AND created_at < NOW() - ($1 || ' minutes')::interval
          AND (mp_external_reference IS NULL OR mp_external_reference <> ALL($3::text[]))
        ORDER BY created_at
        LIMIT $2`,
      [String(mpExpiryMinutes), limit, skipReferences.map(String)]
    );
    return result.rows;
  }

  /** Pasa a `expirado` las ventas indicadas que sigan pendientes y devuelve su stock. */
  static async expireMpByIds(ids) {
    return Order.expirePending({ method: 'mp', ids });
  }

  /** Expira las transferencias pendientes con más de `transferExpiryHours` y devuelve su stock. */
  static async expireStaleTransfers(transferExpiryHours) {
    return Order.expirePending({ method: 'transfer', olderThanHours: transferExpiryHours });
  }

  /**
   * Expira ventas `pendiente` (por ids o por antigüedad) y devuelve el stock que el
   * trigger `trg_decrement_stock` descontó al insertarlas. Bloquea primero en orden
   * de `id` (CTE) y solo toca filas todavía `pendiente`: una venta pagada entre
   * medio no se pisa.
   */
  static async expirePending({ method, ids = null, olderThanHours = null }) {
    if (ids !== null && ids.length === 0) return 0;
    const filter = ids !== null
      ? 'AND id = ANY($2::uuid[])'
      : "AND created_at < NOW() - ($2 || ' hours')::interval";
    return withTransaction('expire_pending', async (client) => {
      const result = await client.query(
        `WITH locked AS (
           SELECT id FROM public.ventas
            WHERE payment_method = $1 AND payment_status = 'pendiente' ${filter}
            ORDER BY id
              FOR UPDATE
         )
         UPDATE public.ventas v SET payment_status = 'expirado'
           FROM locked
          WHERE v.id = locked.id AND v.payment_status = 'pendiente'
          RETURNING v.product_id, v.quantity, v.units_config`,
        [method, ids !== null ? ids : String(olderThanHours)]
      );
      await Order.restoreStockForRows(client, result.rows);
      return result.rowCount;
    });
  }
}

module.exports = Order;
