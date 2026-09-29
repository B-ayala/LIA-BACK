const { pool } = require('../config/database');

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
   * @returns {Promise<{stock: number, price: number, discount: number|null,
   *   original_price: number|null}|null>} fila del producto, o null si no existe.
   */
  static async getProductForUpdate(client, productId) {
    const result = await client.query(
      `SELECT stock, price::float8 AS price, discount::float8 AS discount,
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

  /** Devuelve stock previamente descontado (cancelación / expiración de una orden). */
  static async restoreStock(client, productId, quantity) {
    if (productId == null) return;
    await client.query(
      'UPDATE public.productos SET stock = stock + $2, updated_at = NOW() WHERE id = $1',
      [productId, quantity]
    );
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
   * Marca como pagadas las órdenes indicadas (webhook / confirmación MP).
   * Si una orden ya fue expirada o cancelada (el pago se acreditó tarde),
   * vuelve a descontar el stock que el sweep había devuelto.
   *
   * @param {number} [paidAmount] monto realmente acreditado en Mercado Pago. Si
   *   se pasa y no coincide con la suma de las órdenes (± `tolerance`), NO se
   *   marca nada: un pago por menos del total no puede saldar la compra.
   * @returns {Promise<number>} órdenes marcadas, o -1 si el monto no coincide.
   */
  static async markPaidByIds(ids, paidAmount, tolerance = 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM public.ventas WHERE id::text = ANY($1) FOR UPDATE',
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
        if (row.payment_status === 'pagado') continue;

        const stockWasRestored = ['expirado', 'cancelado'].includes(row.payment_status);
        if (stockWasRestored && row.product_id != null) {
          await client.query(
            'UPDATE public.productos SET stock = GREATEST(stock - $2, 0), updated_at = NOW() WHERE id = $1',
            [row.product_id, row.quantity]
          );
        }
        await client.query(
          "UPDATE public.ventas SET payment_status = 'pagado' WHERE id = $1",
          [row.id]
        );
      }

      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Expira órdenes pendientes vencidas y devuelve el stock que el trigger
   * `trg_decrement_stock` descontó al insertarlas:
   *  - MP: > `mpExpiryMinutes` → 'expirado' + devuelve stock.
   *  - Transferencia: > `transferExpiryHours` → 'expirado' + devuelve stock.
   */
  static async expireStale(mpExpiryMinutes, transferExpiryHours) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const expiredMp = await client.query(
        `UPDATE public.ventas SET payment_status = 'expirado'
         WHERE payment_method = 'mp' AND payment_status = 'pendiente'
           AND created_at < NOW() - ($1 || ' minutes')::interval
         RETURNING product_id, quantity`,
        [String(mpExpiryMinutes)]
      );

      const expiredTransfer = await client.query(
        `UPDATE public.ventas SET payment_status = 'expirado'
         WHERE payment_method = 'transfer' AND payment_status = 'pendiente'
           AND created_at < NOW() - ($1 || ' hours')::interval
         RETURNING product_id, quantity`,
        [String(transferExpiryHours)]
      );

      for (const row of [...expiredMp.rows, ...expiredTransfer.rows]) {
        await Order.restoreStock(client, row.product_id, row.quantity);
      }

      await client.query('COMMIT');
      return { mp: expiredMp.rowCount, transfer: expiredTransfer.rowCount };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = Order;
