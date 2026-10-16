/**
 * Resolución de órdenes de transferencia por el admin (panel Ventas).
 *
 * El stock se descuenta al INSERTAR la venta (trigger trg_decrement_stock), así que:
 *  - confirmar una transferencia pendiente NO toca stock (ya estaba descontado);
 *  - cancelarla DEVUELVE el stock;
 *  - confirmar TARDE una transferencia ya expirada (el sweep devolvió su stock a
 *    las 5 h) vuelve a descontarlo; si ya no hay unidades queda `oversold = true`.
 * Devuelven `{ ok, status?, code?, message?, ... }` sin conocer HTTP.
 */

const Order = require('../models/Order');
const OrderPayment = require('../models/OrderPayment');
const logger = require('../utils/logger');
const { invalidateProducts } = require('../utils/cache');
const { withTransaction, rollbackWith } = require('../utils/transaction');

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

const NOT_FOUND = { ok: false, status: HTTP_NOT_FOUND, code: 'ORDER_NOT_FOUND', message: 'Orden no encontrada' };
const NOT_TRANSFER = { ok: false, status: HTTP_CONFLICT, code: 'NOT_A_TRANSFER', message: 'La orden no es de transferencia' };

/** Problema que impide actuar sobre la orden, o null si está en `expectedStatus`. */
const findTransferProblem = (order, expectedStatus, conflict) => {
  if (!order) return NOT_FOUND;
  if (order.payment_method !== 'transfer') return NOT_TRANSFER;
  if (order.payment_status !== expectedStatus) return conflict(order.payment_status);
  return null;
};

const notPendingConflict = (current) => ({
  ok: false,
  status: HTTP_CONFLICT,
  code: 'ORDER_NOT_PENDING',
  message: `La orden ya no está pendiente (estado actual: ${current})`,
});

const notExpiredConflict = (current) => ({
  ok: false,
  status: HTTP_CONFLICT,
  code: 'ORDER_NOT_EXPIRED',
  message: `Solo se puede confirmar tarde una transferencia expirada (estado actual: ${current}).`,
});

/** Confirma (`pagado`) o cancela (`cancelado`) una transferencia pendiente. */
const resolvePendingTransfer = async (orderId, targetStatus, actor) => {
  const result = await withTransaction(`resolve_transfer_${targetStatus}`, async (client) => {
    const order = await Order.findByIdForUpdate(client, orderId);
    const problem = findTransferProblem(order, 'pendiente', notPendingConflict);
    if (problem) return rollbackWith(problem);

    if (targetStatus === 'cancelado') {
      await Order.cancelLockedPending(client, [order]);
    } else {
      await Order.setStatus(client, order.id, targetStatus);
    }
    return { ok: true };
  }, { actor });
  if (result.ok && targetStatus === 'cancelado') invalidateProducts();
  return result;
};

/**
 * Confirma una transferencia que ya había expirado (el comprador pagó tarde).
 * @returns {Promise<{ok: true, oversold: boolean} | {ok: false, status: number, code: string, message: string}>}
 */
const confirmLateTransfer = async (orderId, actor) => {
  const result = await withTransaction('confirm_late_transfer', async (client) => {
    const order = await Order.findByIdForUpdate(client, orderId);
    const problem = findTransferProblem(order, 'expirado', notExpiredConflict);
    if (problem) return rollbackWith(problem);

    const rededucted = await OrderPayment.redeductForLatePayment(client, order);
    await OrderPayment.markLateTransferPaid(client, order.id, !rededucted);
    return { ok: true, oversold: !rededucted, productId: order.product_id, quantity: order.quantity };
  }, { actor });
  if (!result.ok) return result;

  invalidateProducts();
  if (result.oversold) {
    logger.error('oversold_late_transfer', { orderId: String(orderId), productId: result.productId, quantity: result.quantity });
  }
  return { ok: true, oversold: result.oversold };
};

module.exports = { resolvePendingTransfer, confirmLateTransfer };
