const { pool } = require('../config/database');
const logger = require('../utils/logger');
const Order = require('./Order');
const { withTransaction, rollbackWith } = require('../utils/transaction');
const { REVIEW_REASON } = require('../utils/reviewReasons');
const { DEDUCT, REASON, validateSizeStock, applySizeDelta } = require('../utils/variantStock');

const RELEASED_STATUSES = ['expirado', 'cancelado'];
const AMOUNT_MISMATCH = -1;

// Columna → migración que la crea (aviso de arranque si falta alguna).
const PAYMENT_COLUMN_MIGRATIONS = {
  mp_external_reference: '2026-10-13_payment_reconciliation_and_schema_hardening.sql',
  mp_payment_id: '2026-10-13_payment_reconciliation_and_schema_hardening.sql',
  oversold: '2026-10-13_payment_reconciliation_and_schema_hardening.sql',
  review_reason: '2026-10-14_add_review_reason_to_ventas.sql',
  order_number: '2026-10-27_order_number_and_withdrawal_requests.sql',
};
const PAYMENT_COLUMNS = Object.keys(PAYMENT_COLUMN_MIGRATIONS);

// Filtro de estado para setReviewReason.
const STATUS_FILTER = { paid: 'paid', unpaid: 'unpaid' };

const byProductId = (a, b) => (Number(a.product_id) || 0) - (Number(b.product_id) || 0);
const asText = (value) => (value == null ? null : String(value));
const isDuplicatePayment = (row, paymentRef) =>
  paymentRef !== null && Boolean(row.mp_payment_id) && row.mp_payment_id !== paymentRef;

/**
 * Cobros de Mercado Pago sobre `ventas`: saldar, pago tardío, conciliación y
 * marcas de revisión (`review_reason`).
 */
class OrderPayment {
  /** Suma los totales de las órdenes indicadas (control de monto de un pago). */
  static async sumTotalsByIds(client, ids) {
    const result = await client.query(
      'SELECT COALESCE(SUM(total_price), 0)::float8 AS total FROM public.ventas WHERE id = ANY($1::uuid[])',
      [ids]
    );
    return result.rows[0].total;
  }

  /**
   * Vuelve a descontar el stock de una venta cuyo pago se acreditó después de que
   * la reserva se liberó. NO hace clamp a 0: si no hay unidades (total o talle), si
   * el producto ya no existe o si su stock es NULL (mismo criterio conservador que
   * la reserva) no toca nada y devuelve false: la venta queda sobrevendida.
   * @returns {Promise<boolean>} true si descontó.
   */
  static async redeductForLatePayment(client, row) {
    const result = row.product_id == null ? { rows: [] } : await client.query(
      'SELECT stock, variants FROM public.productos WHERE id = $1 FOR UPDATE',
      [row.product_id]
    );
    const product = result.rows[0];
    if (!product || product.stock === null) {
      logger.warn('late_payment_without_stock_control', {
        orderId: String(row.id), productId: row.product_id, productExists: Boolean(product),
      });
      return false;
    }

    const sizeCheck = validateSizeStock(product.variants, row.units_config, row.quantity);
    const sizeShort = !sizeCheck.ok && sizeCheck.reason !== REASON.missingSize;
    if (Number(product.stock) < row.quantity || sizeShort) return false;

    await client.query(
      'UPDATE public.productos SET stock = stock - $2, updated_at = NOW() WHERE id = $1',
      [row.product_id, row.quantity]
    );
    const nextVariants = applySizeDelta(product.variants, row.units_config, DEDUCT);
    if (nextVariants) await Order.setVariants(client, row.product_id, nextVariants);
    return true;
  }

  /**
   * Marca como pagadas las órdenes indicadas (webhook / confirmación MP / conciliación).
   * Pago tardío sobre una orden liberada: re-descuenta stock o, si no hay, deja
   * `oversold = true`. Un segundo pago aprobado sobre ventas ya pagadas las marca
   * `review_reason = 'duplicate_payment'`.
   *
   * @param {number} [paidAmount] monto acreditado; si no coincide con la suma de las
   *   órdenes (± `tolerance`) NO se marca nada.
   * @returns {Promise<number>} órdenes REALMENTE pasadas a `pagado` (las que ya lo
   *   estaban no cuentan), o -1 si el monto no coincide.
   */
  static async markPaidByIds(ids, paidAmount, tolerance = 1, paymentId = null) {
    const paymentRef = asText(paymentId);
    const outcome = await withTransaction('mark_paid', async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM public.ventas WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [ids]
      );
      if (Number.isFinite(paidAmount)) {
        const expected = await OrderPayment.sumTotalsByIds(client, ids);
        if (Math.abs(expected - paidAmount) > tolerance) return rollbackWith({ marked: AMOUNT_MISMATCH });
      }
      return OrderPayment.applyPayment(client, rows, paymentRef);
    });

    if (outcome.marked === AMOUNT_MISMATCH) return AMOUNT_MISMATCH;
    OrderPayment.logPaymentAnomalies(outcome.oversold, outcome.duplicates, paymentRef);
    return outcome.marked;
  }

  /** Aplica el pago a filas ya bloqueadas. Productos en orden ascendente (mismo orden que la reserva). */
  static async applyPayment(client, rows, paymentRef) {
    const oversold = [];
    const duplicates = [];
    let marked = 0;
    for (const row of [...rows].sort(byProductId)) {
      if (row.payment_status === 'pagado') {
        if (isDuplicatePayment(row, paymentRef)) duplicates.push(row);
        continue;
      }
      const wasReleased = RELEASED_STATUSES.includes(row.payment_status);
      const isOversold = wasReleased && !(await OrderPayment.redeductForLatePayment(client, row));
      if (isOversold) oversold.push(row);
      await client.query(
        `UPDATE public.ventas
            SET payment_status = 'pagado', mp_payment_id = COALESCE($2::text, mp_payment_id), oversold = $3
          WHERE id = $1`,
        [row.id, paymentRef, isOversold]
      );
      marked += 1;
    }
    if (duplicates.length > 0) {
      await OrderPayment.setReviewReason(duplicates.map((row) => row.id), REVIEW_REASON.duplicatePayment, {}, client);
    }
    return { marked, oversold, duplicates };
  }

  /** Logs de error para lo que requiere acción humana (se emiten recién después del COMMIT). */
  static logPaymentAnomalies(oversold, duplicates, paymentRef) {
    for (const row of oversold) {
      logger.error('oversold_late_payment', {
        orderId: String(row.id), productId: row.product_id, quantity: row.quantity, paymentId: paymentRef,
      });
    }
    for (const row of duplicates) {
      logger.error('duplicate_approved_payment', {
        orderId: String(row.id), recordedPaymentId: row.mp_payment_id, newPaymentId: paymentRef,
      });
    }
  }

  /** Transferencia expirada que el admin confirma tarde (fila ya bloqueada por el caller). */
  static async markLateTransferPaid(client, id, oversold) {
    await client.query(
      "UPDATE public.ventas SET payment_status = 'pagado', oversold = $2 WHERE id = $1::uuid",
      [id, oversold]
    );
  }

  /**
   * Marca ventas para revisión del admin. No cambia estado ni stock.
   * @param {{status?: 'paid'|'unpaid', overwrite?: boolean, paymentId?: string|null}} [options]
   *   `paymentId`: solo filas saldadas con ese pago (o sin pago registrado).
   * @returns {Promise<number>} filas marcadas.
   */
  static async setReviewReason(ids, reason, options = {}, client = pool) {
    const { status = null, overwrite = false, paymentId = null } = options;
    const result = await client.query(
      `UPDATE public.ventas SET review_reason = $2
        WHERE id = ANY($1::uuid[])
          AND ($3::text IS NULL OR ($3::text = 'paid') = (payment_status = 'pagado'))
          AND ($4::boolean OR review_reason IS NULL)
          AND ($5::text IS NULL OR mp_payment_id IS NULL OR mp_payment_id = $5::text)`,
      [ids, reason, status, overwrite, asText(paymentId)]
    );
    return result.rowCount;
  }

  /** Ids de las ventas de una compra (`mp_external_reference`). */
  static async findIdsByReference(reference) {
    const result = await pool.query(
      'SELECT id FROM public.ventas WHERE mp_external_reference = $1 ORDER BY id',
      [String(reference)]
    );
    return result.rows.map((row) => String(row.id));
  }

  /** Guarda en las ventas de un carrito la preferencia de MP creada para cobrarlo. */
  static async setPreferenceId(orderIds, preferenceId) {
    await pool.query(
      'UPDATE public.ventas SET mp_preference_id = $2::text WHERE id = ANY($1::uuid[])',
      [orderIds, preferenceId || null]
    );
  }

  /**
   * Compras de MP cerradas (expiradas / canceladas) recientes y sin marca de
   * revisión: candidatas a conciliar por si MP acreditó un pago después.
   */
  static async findRecentlyClosedMpReferences(lookbackHours, limit) {
    const result = await pool.query(
      `SELECT mp_external_reference AS reference
         FROM public.ventas
        WHERE payment_method = 'mp' AND payment_status IN ('expirado', 'cancelado')
          AND mp_external_reference IS NOT NULL AND review_reason IS NULL
          AND created_at > NOW() - make_interval(hours => $1)
        GROUP BY mp_external_reference
        ORDER BY MAX(created_at) DESC
        LIMIT $2`,
      [lookbackHours, limit]
    );
    return result.rows.map((row) => row.reference);
  }

  /** Columnas de conciliación que faltan en `ventas`, con la migración que las crea. */
  static async findMissingPaymentColumns() {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ventas' AND column_name = ANY($1)`,
      [PAYMENT_COLUMNS]
    );
    const present = new Set(result.rows.map((row) => row.column_name));
    return PAYMENT_COLUMNS
      .filter((column) => !present.has(column))
      .map((column) => ({ column, migration: PAYMENT_COLUMN_MIGRATIONS[column] }));
  }
}

OrderPayment.STATUS_FILTER = STATUS_FILTER;
OrderPayment.AMOUNT_MISMATCH = AMOUNT_MISMATCH;

module.exports = OrderPayment;
