const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { RESTORE, DEDUCT, REASON, validateSizeStock, applySizeDelta } = require('../utils/variantStock');

const RELEASED_STATUSES = ['expirado', 'cancelado'];
const PAYMENT_COLUMNS = ['mp_external_reference', 'mp_payment_id', 'oversold'];

/**
 * Acceso a datos de órdenes (tabla public.ventas) y stock (public.productos).
 * Los métodos que reciben `client` participan de una transacción abierta
 * por el caller; los demás manejan su propia conexión.
 */
class Order {
  /**
   * Compras pagadas de un usuario, más recientes primero, paginadas.
   * El total viaja en la misma consulta (`COUNT(*) OVER()`) para no pagar un
   * segundo round trip por request.
   * @returns {Promise<{rows: object[], total: number}>}
   */
  static async findPaidByEmail(email, limit, offset) {
    const result = await pool.query(
      `SELECT id, user_id, buyer_name, buyer_email, product_id, product_name,
              product_image, quantity, unit_price, total_price, units_config,
              payment_method, payment_status, shipping_method, dispatch_status,
              mp_preference_id, origin, created_at, paid_at, dispatched_at,
              COUNT(*) OVER()::int AS total_count
         FROM public.ventas
        WHERE LOWER(buyer_email) = LOWER($1) AND payment_status = 'pagado'
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [email, limit, offset]
    );

    const rows = result.rows.map(({ total_count, ...order }) => order);
    return { rows, total: rows.length > 0 ? result.rows[0].total_count : 0 };
  }

  /** Lectura sin bloqueo (para decidir antes de abrir una transacción). */
  static async findById(id) {
    const result = await pool.query('SELECT * FROM public.ventas WHERE id::text = $1', [String(id)]);
    return result.rows[0] || null;
  }

  /** Bloquea la fila de la orden para actualizarla dentro de una transacción. */
  static async findByIdForUpdate(client, id) {
    const result = await client.query(
      'SELECT * FROM public.ventas WHERE id::text = $1 FOR UPDATE',
      [String(id)]
    );
    return result.rows[0] || null;
  }

  /**
   * Bloquea la fila del producto y devuelve stock y precio vigentes.
   *
   * El descuento de stock real lo hace el trigger `trg_decrement_stock` al
   * insertar la venta; esto sirve para validar disponibilidad de forma atómica
   * (el `FOR UPDATE` serializa transacciones concurrentes sobre el mismo
   * producto) y, sobre todo, para **tomar el precio de la base y no del cliente**.
   *
   * @returns {Promise<{stock: number, variants: object[]|null, price: number, discount: number|null,
   *   original_price: number|null}|null>} fila del producto, o null si no existe.
   */
  static async getProductForUpdate(client, productId) {
    const result = await client.query(
      `SELECT stock, variants, price::float8 AS price, discount::float8 AS discount,
              original_price::float8 AS original_price
         FROM public.productos
        WHERE id = $1
          FOR UPDATE`,
      [productId]
    );
    return result.rows[0] || null;
  }

  /** Suma los totales de las órdenes indicadas (control de monto de un pago). */
  static async sumTotalsByIds(client, ids) {
    const result = await client.query(
      `SELECT COALESCE(SUM(total_price), 0)::float8 AS total
         FROM public.ventas
        WHERE id::text = ANY($1)`,
      [ids.map(String)]
    );
    return result.rows[0].total;
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

  /**
   * Vuelve a descontar el stock de una venta cuyo pago se acreditó después de que
   * la reserva se liberó. NO hace clamp a 0: si ya no hay unidades (total o talle)
   * no toca nada y devuelve false para que la venta quede marcada como sobrevendida.
   * @returns {Promise<boolean>} true si descontó, false si no había stock suficiente.
   */
  static async redeductForLatePayment(client, row) {
    const result = await client.query(
      'SELECT stock, variants FROM public.productos WHERE id = $1 FOR UPDATE',
      [row.product_id]
    );
    const product = result.rows[0];
    if (!product || product.stock === null) return true;

    const sizeCheck = validateSizeStock(product.variants, row.units_config, row.quantity);
    const sizeShort = !sizeCheck.ok && sizeCheck.reason !== REASON.missingSize;
    if (product.stock < row.quantity || sizeShort) return false;

    await client.query(
      'UPDATE public.productos SET stock = stock - $2, updated_at = NOW() WHERE id = $1',
      [row.product_id, row.quantity]
    );
    const nextVariants = applySizeDelta(product.variants, row.units_config, DEDUCT);
    if (nextVariants) await Order.setVariants(client, row.product_id, nextVariants);
    return true;
  }

  /** Inserta una línea de venta pendiente y devuelve su id. */
  static async insertPending(client, row) {
    const result = await client.query(
      `INSERT INTO public.ventas
        (buyer_name, buyer_email, user_id, product_id, product_name, product_image,
         quantity, unit_price, total_price, units_config,
         payment_method, payment_status, shipping_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pendiente', $12)
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
      ]
    );
    return result.rows[0].id;
  }

  static async setStatus(client, id, status) {
    await client.query(
      'UPDATE public.ventas SET payment_status = $2 WHERE id::text = $1',
      [String(id), status]
    );
  }

  /** Registra la respuesta del nudge post-WhatsApp ('origin') de una orden. */
  static async setOrigin(client, id, origin) {
    await client.query(
      'UPDATE public.ventas SET origin = $2 WHERE id::text = $1',
      [String(id), origin]
    );
  }

  /**
   * Marca como pagadas las órdenes indicadas (webhook / confirmación MP / conciliación).
   * Si una orden ya fue expirada o cancelada (el pago se acreditó tarde), intenta
   * volver a descontar el stock que se había devuelto. Si ya no hay unidades NO
   * se hace clamp: la venta queda `pagado` con `oversold = true` y un log de error,
   * para que el admin reembolse o consiga la mercadería.
   *
   * @param {number} [paidAmount] monto realmente acreditado en Mercado Pago. Si
   *   se pasa y no coincide con la suma de las órdenes (± `tolerance`), NO se
   *   marca nada: un pago por menos del total no puede saldar la compra.
   * @param {number} [tolerance]
   * @param {string|number} [paymentId] id del pago de MP que salda las órdenes.
   * @returns {Promise<number>} órdenes marcadas, o -1 si el monto no coincide.
   */
  static async markPaidByIds(ids, paidAmount, tolerance = 1, paymentId = null) {
    const client = await pool.connect();
    const oversold = [];
    const duplicates = [];
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM public.ventas WHERE id::text = ANY($1) ORDER BY product_id FOR UPDATE',
        [ids.map(String)]
      );

      if (Number.isFinite(paidAmount)) {
        const expected = await Order.sumTotalsByIds(client, ids);
        if (Math.abs(expected - paidAmount) > tolerance) {
          await client.query('ROLLBACK');
          return -1;
        }
      }

      for (const row of rows) {
        if (row.payment_status === 'pagado') {
          if (paymentId != null && row.mp_payment_id && row.mp_payment_id !== String(paymentId)) {
            duplicates.push(row);
          }
          continue;
        }

        const wasReleased = RELEASED_STATUSES.includes(row.payment_status);
        const isOversold = wasReleased && row.product_id != null
          ? !(await Order.redeductForLatePayment(client, row))
          : false;
        if (isOversold) oversold.push(row);

        await client.query(
          `UPDATE public.ventas
              SET payment_status = 'pagado',
                  mp_payment_id = COALESCE($2::text, mp_payment_id),
                  oversold = $3
            WHERE id = $1`,
          [row.id, paymentId == null ? null : String(paymentId), isOversold]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    Order.logPaymentAnomalies(oversold, duplicates, paymentId);
    return rows.length;
  }

  /** Logs de error para lo que requiere acción humana (se emiten recién después del COMMIT). */
  static logPaymentAnomalies(oversold, duplicates, paymentId) {
    for (const row of oversold) {
      logger.error('oversold_late_payment', {
        orderId: String(row.id), productId: row.product_id, quantity: row.quantity,
        paymentId: paymentId == null ? null : String(paymentId),
      });
    }
    for (const row of duplicates) {
      logger.error('duplicate_approved_payment', {
        orderId: String(row.id), recordedPaymentId: row.mp_payment_id, newPaymentId: String(paymentId),
      });
    }
  }

  /** Guarda en las ventas de un carrito la preferencia y la referencia que se le mandó a MP. */
  static async setPaymentRefs(orderIds, { preferenceId, externalReference }) {
    await pool.query(
      `UPDATE public.ventas
          SET mp_preference_id = $2::text, mp_external_reference = $3::text
        WHERE id::text = ANY($1)`,
      [orderIds.map(String), preferenceId || null, externalReference]
    );
  }

  /** Nombres de las columnas de conciliación que faltan en `ventas` (migración sin aplicar). */
  static async findMissingPaymentColumns() {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ventas' AND column_name = ANY($1)`,
      [PAYMENT_COLUMNS]
    );
    const present = new Set(result.rows.map((row) => row.column_name));
    return PAYMENT_COLUMNS.filter((column) => !present.has(column));
  }

  /** Órdenes de MP pendientes cuyo plazo venció, las más viejas primero (candidatas a expirar). */
  static async findStaleMpOrders(mpExpiryMinutes, limit) {
    const result = await pool.query(
      `SELECT id, mp_external_reference, created_at
         FROM public.ventas
        WHERE payment_method = 'mp' AND payment_status = 'pendiente'
          AND created_at < NOW() - ($1 || ' minutes')::interval
        ORDER BY created_at
        LIMIT $2`,
      [String(mpExpiryMinutes), limit]
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
   * trigger `trg_decrement_stock` descontó al insertarlas. El UPDATE solo toca filas
   * todavía `pendiente`: una venta pagada entre medio no se pisa.
   */
  static async expirePending({ method, ids = null, olderThanHours = null }) {
    if (ids !== null && ids.length === 0) return 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const filter = ids !== null
        ? 'AND id::text = ANY($2)'
        : "AND created_at < NOW() - ($2 || ' hours')::interval";
      const result = await client.query(
        `UPDATE public.ventas SET payment_status = 'expirado'
          WHERE payment_method = $1 AND payment_status = 'pendiente' ${filter}
          RETURNING product_id, quantity, units_config`,
        [method, ids !== null ? ids.map(String) : String(olderThanHours)]
      );
      const byProduct = [...result.rows].sort((a, b) => Number(a.product_id) - Number(b.product_id));
      for (const row of byProduct) {
        await Order.restoreStock(client, row.product_id, row.quantity, row.units_config);
      }
      await client.query('COMMIT');
      return result.rowCount;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = Order;
