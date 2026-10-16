const { pool } = require('../config/database');

// Comparar `id = $1::uuid` (y no `id::text`) permite usar ventas_pkey; los ids mal formados nunca matchean.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_RE.test(String(value));
const uuidsOnly = (ids) => ids.map(String).filter(isUuid);

// Nombre del índice UNIQUE parcial (db/migrations/2026-10-06_idempotency_key.sql):
// permite distinguir su unique_violation de cualquier otra.
const IDEMPOTENCY_INDEX = 'ventas_user_idempotency_key_uidx';
const UNIQUE_VIOLATION = '23505';
// Separa la key del cliente del índice de línea (la key del cliente no admite ':').
const LINE_SEPARATOR = ':';

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
   * Con `ownerUserId` (el propio comprador) también cuenta las compras ligadas a su
   * `user_id` aunque haya cambiado de email; las filas históricas sin `user_id` se
   * siguen resolviendo por email. Sin `ownerUserId` (admin consultando) es solo por email.
   * @returns {Promise<{rows: object[], total: number}>}
   */
  static async findPaidByEmail(email, limit, offset, ownerUserId = null) {
    const ownerFilter = ownerUserId
      ? '(user_id = $4::uuid OR (user_id IS NULL AND LOWER(buyer_email) = LOWER($1)))'
      : 'LOWER(buyer_email) = LOWER($1)';
    const params = ownerUserId ? [email, limit, offset, ownerUserId] : [email, limit, offset];
    const result = await pool.query(
      `SELECT id, user_id, buyer_name, buyer_email, product_id, product_name,
              product_image, quantity, unit_price, total_price, units_config,
              payment_method, payment_status, shipping_method, dispatch_status,
              mp_preference_id, origin, created_at, paid_at, dispatched_at,
              COUNT(*) OVER()::int AS total_count
         FROM public.ventas
        WHERE ${ownerFilter} AND payment_status = 'pagado'
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      params
    );

    const rows = result.rows.map(({ total_count, ...order }) => order);
    return { rows, total: rows.length > 0 ? result.rows[0].total_count : 0 };
  }

  /** Bloquea la fila de la orden para actualizarla dentro de una transacción. */
  static async findByIdForUpdate(client, id) {
    if (!isUuid(id)) return null;
    const result = await client.query(
      'SELECT * FROM public.ventas WHERE id = $1::uuid FOR UPDATE',
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
   * También devuelve nombre e imagen: lo persistido y lo que ve Mercado Pago sale
   * de la base, no del body del cliente.
   *
   * @returns {Promise<{stock: number, price: number, discount: number|null,
   *   original_price: number|null, name: string, image_url: string|null,
   *   status: string|null}|null>}
   *   fila del producto, o null si no existe.
   */
  static async getProductForUpdate(client, productId) {
    const result = await client.query(
      `SELECT stock, price::float8 AS price, discount::float8 AS discount,
              original_price::float8 AS original_price, name, image_url, status
         FROM public.productos
        WHERE id = $1
          FOR UPDATE`,
      [productId]
    );
    return result.rows[0] || null;
  }

  /**
   * Toma los locks de varios productos en orden de id ascendente. Dos carritos con
   * los mismos productos en distinto orden ([A,B] y [B,A]) ya no se bloquean entre sí (deadlock 40P01).
   */
  static async lockProductsInOrder(client, productIds) {
    if (productIds.length === 0) return;
    await client.query(
      'SELECT id FROM public.productos WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
      [productIds]
    );
  }

  /**
   * Líneas de venta pendientes (stock reservado y sin pagar) de un usuario.
   * Acota cuánto stock puede retener una sola cuenta sin comprar.
   */
  static async countPendingByUser(client, userId) {
    const result = await client.query(
      "SELECT COUNT(*)::int AS pending FROM public.ventas WHERE user_id = $1::uuid AND payment_status = 'pendiente'",
      [String(userId)]
    );
    return result.rows[0].pending;
  }

  /** Suma los totales de las órdenes indicadas (control de monto de un pago). */
  static async sumTotalsByIds(client, ids) {
    const result = await client.query(
      `SELECT COALESCE(SUM(total_price), 0)::float8 AS total
         FROM public.ventas
        WHERE id = ANY($1::uuid[])`,
      [uuidsOnly(ids)]
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

  /**
   * Inserta una línea de venta pendiente y devuelve su id.
   * `idempotencyKey` / `lineIndex` solo tocan la columna `idempotency_key` cuando el
   * cliente mandó la key: sin ella el INSERT es el de siempre y no depende de la migración.
   */
  static async insertPending(client, row) {
    const keyed = Boolean(row.idempotencyKey);
    const result = await client.query(
      `INSERT INTO public.ventas
        (buyer_name, buyer_email, user_id, product_id, product_name, product_image,
         quantity, unit_price, total_price, units_config,
         payment_method, payment_status, shipping_method${keyed ? ', idempotency_key' : ''})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pendiente', $12${keyed ? ', $13' : ''})
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
        ...(keyed ? [Order.buildStoredKey(row)] : []),
      ]
    );
    return result.rows[0].id;
  }

  /** Valor persistido: `<key>:<huella>:<índice>` (sin huella, `<key>:<índice>`, formato anterior). */
  static buildStoredKey({ idempotencyKey, requestHash, lineIndex }) {
    const parts = requestHash ? [idempotencyKey, requestHash, lineIndex] : [idempotencyKey, lineIndex];
    return parts.join(LINE_SEPARATOR);
  }

  /**
   * Serializa las requests concurrentes del mismo (user_id, Idempotency-Key) hasta el
   * fin de la transacción. Hace falta porque la huella va dentro del valor: dos carritos
   * distintos con la misma key no chocarían en el índice UNIQUE.
   */
  static async lockIdempotencyKey(client, userId, idempotencyKey) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${userId}${LINE_SEPARATOR}${idempotencyKey}`,
    ]);
  }

  /**
   * Líneas de una reserva previa de (user_id, Idempotency-Key), en el orden del carrito.
   * `request_hash` es null en filas con el formato anterior (`<key>:<índice>`).
   * @returns {Promise<object[]>} vacío si la key nunca se usó.
   */
  static async findByIdempotencyKey(client, userId, idempotencyKey) {
    const result = await client.query(
      `SELECT id, product_name, product_image, quantity, unit_price::float8 AS unit_price,
              total_price::float8 AS total_price, payment_method, payment_status,
              NULLIF(CASE WHEN split_part(idempotency_key, '${LINE_SEPARATOR}', 3) = ''
                          THEN '' ELSE split_part(idempotency_key, '${LINE_SEPARATOR}', 2) END, '') AS request_hash
         FROM public.ventas
        WHERE user_id = $1::uuid
          AND idempotency_key IS NOT NULL
          AND split_part(idempotency_key, '${LINE_SEPARATOR}', 1) = $2
        ORDER BY substring(idempotency_key from '[^${LINE_SEPARATOR}]+$')::int`,
      [String(userId), idempotencyKey]
    );
    return result.rows;
  }

  /** Libera la key de una reserva compensada (MP falló): permite reintentar con la misma. */
  static async clearIdempotencyKey(client, id) {
    if (!isUuid(id)) return;
    await client.query(
      'UPDATE public.ventas SET idempotency_key = NULL WHERE id = $1::uuid AND idempotency_key IS NOT NULL',
      [String(id)]
    );
  }

  /** true si el error es el unique_violation del índice de idempotencia (carrera entre dos requests). */
  static isIdempotencyConflict(error) {
    return error.code === UNIQUE_VIOLATION && error.constraint === IDEMPOTENCY_INDEX;
  }

  static async setStatus(client, id, status) {
    if (!isUuid(id)) return;
    await client.query(
      'UPDATE public.ventas SET payment_status = $2 WHERE id = $1::uuid',
      [String(id), status]
    );
  }

  /** Registra la respuesta del nudge post-WhatsApp ('origin') de una orden. */
  static async setOrigin(client, id, origin) {
    if (!isUuid(id)) return;
    await client.query(
      'UPDATE public.ventas SET origin = $2 WHERE id = $1::uuid',
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
        'SELECT * FROM public.ventas WHERE id = ANY($1::uuid[]) FOR UPDATE',
        [uuidsOnly(ids)]
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
