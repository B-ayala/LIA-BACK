const Order = require('../models/Order');
const logger = require('../utils/logger');
const { invalidateProducts } = require('../utils/cache');
const { sendError } = require('../utils/httpResponses');
const { isUuid } = require('../utils/uuid');
const { isOrderOwnerOrAdmin } = require('../utils/orderAccess');
const { withTransaction } = require('../utils/transaction');
const { cancelMpOrder, cancelMpPurchases } = require('../services/mpCancellation');

const MAX_ORDER_IDS = 50;

// Respuestas del nudge "¿al final comprás?" (checkout transferencia) → valor de
// `origin` en ventas. 'abandonado' además cancela la orden y devuelve el stock.
const NUDGE_ORIGIN = {
  confirmado: 'wa_confirmado',
  sin_confirmar: 'wa_sin_confirmar',
  abandonado: 'wa_abandonado',
};

/** Lista de 1..50 uuids sin repetir, o null si el body no cumple. */
const parseOrderIds = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ORDER_IDS) return null;
  if (!raw.every(isUuid)) return null;
  return [...new Set(raw.map((id) => id.toLowerCase()))];
};

const INVALID_ORDER_IDS_MESSAGE = 'Lista de órdenes inválida';

// Estado de cancelMpOrder → respuesta HTTP (contrato de POST /:id/cancel).
const CANCEL_RESPONSES = {
  held: [200, {
    success: true,
    released: false,
    message: 'Tu pago todavía se está procesando. Mantenemos la reserva hasta que se confirme.',
  }],
  paid: [409, { success: false, code: 'ORDER_ALREADY_PAID', message: 'La orden ya fue pagada y no puede cancelarse' }],
  not_found: [404, { success: false, code: 'ORDER_NOT_FOUND', message: 'Orden no encontrada' }],
  not_mp: [409, {
    success: false, code: 'NOT_MP_ORDER', message: 'Solo se cancelan órdenes de Mercado Pago por esta vía',
  }],
  already_released: [200, { success: true, message: 'La orden ya estaba cancelada' }],
  cancelled: [200, { success: true, message: 'Orden cancelada' }],
};

/**
 * @desc    Cancela una orden MP pendiente (usuario volvió sin pagar) y devuelve stock.
 *          Si MP tiene un pago aprobado (409) o en curso (200 released:false), no cancela.
 * @route   POST /api/orders/:id/cancel
 */
const cancelOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json(CANCEL_RESPONSES.not_found[1]);
    if (!isOrderOwnerOrAdmin(req.user, order)) {
      return sendError(res, 403, 'FORBIDDEN', 'No podés cancelar esta orden');
    }
    const [status, body] = CANCEL_RESPONSES[await cancelMpOrder(order)];
    return res.status(status).json(body);
  } catch (error) {
    logger.error('order_cancel_failed', { orderId: req.params.id, code: error.code, message: error.message });
    return sendError(res, 500, 'INTERNAL_ERROR', 'Error al cancelar la orden');
  }
};

/**
 * @desc    Cancela las compras MP de un carrito (vuelta sin pagar). Una consulta a MP
 *          por compra; `outcome` agregado: paid > held > released.
 * @route   POST /api/orders/mp-cancel
 */
const cancelMpOrders = async (req, res) => {
  const orderIds = parseOrderIds(req.body && req.body.orderIds);
  if (!orderIds) return sendError(res, 400, 'INVALID_ORDER_IDS', INVALID_ORDER_IDS_MESSAGE);

  try {
    const result = await cancelMpPurchases(req.user, orderIds);
    if (result.forbidden) return sendError(res, 403, 'FORBIDDEN', 'No podés cancelar estas órdenes');
    return res.status(200).json({ success: true, outcome: result.outcome });
  } catch (error) {
    logger.error('mp_cancel_failed', { count: orderIds.length, code: error.code, message: error.message });
    return sendError(res, 500, 'INTERNAL_ERROR', 'No se pudo cancelar la compra. Intentá de nuevo.');
  }
};

/** Solo se actúa sobre órdenes de transferencia, pendientes y del propio usuario (o admin). */
const canActOnNudgeOrder = (order, user) =>
  order.payment_method === 'transfer'
  && order.payment_status === 'pendiente'
  && isOrderOwnerOrAdmin(user, order);

const applyNudge = (ids, user, origin) => withTransaction('record_nudge', async (client) => {
  const rows = await Order.findByIdsForUpdate(client, ids);
  const actionable = rows.filter((order) => canActOnNudgeOrder(order, user));
  for (const order of actionable) await Order.setOrigin(client, order.id, origin);
  if (origin === NUDGE_ORIGIN.abandonado) await Order.cancelLockedPending(client, actionable);
  return actionable.length;
});

/**
 * @desc    Registra la respuesta del nudge post-WhatsApp del checkout transferencia.
 *          'abandonado' cancela las órdenes y devuelve stock; el resto solo marca `origin`.
 * @route   POST /api/orders/nudge
 */
const recordNudge = async (req, res) => {
  const { orderIds, response } = req.body || {};
  const origin = NUDGE_ORIGIN[response];
  if (!origin) return sendError(res, 400, 'INVALID_NUDGE_RESPONSE', 'Respuesta de nudge inválida');
  const ids = parseOrderIds(orderIds);
  if (!ids) return sendError(res, 400, 'INVALID_ORDER_IDS', INVALID_ORDER_IDS_MESSAGE);

  try {
    const applied = await applyNudge(ids, req.user, origin);
    if (origin === NUDGE_ORIGIN.abandonado && applied > 0) invalidateProducts();
    return res.status(200).json({ success: true, applied });
  } catch (error) {
    logger.error('nudge_failed', { code: error.code, message: error.message });
    return sendError(res, 500, 'INTERNAL_ERROR', 'No se pudo registrar la respuesta');
  }
};

module.exports = { cancelOrder, cancelMpOrders, recordNudge };
