/**
 * Cancelación de compras de Mercado Pago (el comprador volvió sin pagar).
 *
 * Antes de liberar stock se le pregunta a MP si hay un pago para esa compra:
 * liberar una reserva que MP todavía procesa dejaría una venta pagada sin unidad.
 * La consulta va ANTES de abrir la transacción: mientras MP responde (hasta 8 s)
 * no se retiene ninguna conexión del pool ni ningún lock.
 *
 * Resultado por compra (`outcome`):
 *  - released → se canceló y devolvió el stock (o ya estaba cancelada/expirada).
 *  - held     → hay un pago en curso o MP no respondió: NO se cancela.
 *  - paid     → hay un pago aprobado: se salda y NO se cancela.
 */

const Order = require('../models/Order');
const mercadopago = require('../utils/mercadopago');
const { invalidateProducts } = require('../utils/cache');
const { withTransaction } = require('../utils/transaction');
const { PAYMENT_STATE, checkPaymentState } = require('../utils/paymentReconciliation');
const { settleApprovedPayment, AMOUNT_MISMATCH } = require('../utils/paymentSettlement');
const { isOrderOwnerOrAdmin } = require('../utils/orderAccess');

const CANCEL_OUTCOME = Object.freeze({ released: 'released', held: 'held', paid: 'paid' });
const OUTCOME_PRIORITY = { released: 0, held: 1, paid: 2 };
const RELEASED_STATUSES = ['cancelado', 'expirado'];

/** Precedencia del resultado agregado: paid > held > released. */
const mergeOutcomes = (outcomes) => outcomes.reduce(
  (current, outcome) => (OUTCOME_PRIORITY[outcome] > OUTCOME_PRIORITY[current] ? outcome : current),
  CANCEL_OUTCOME.released
);

const canAskMercadoPago = (order) =>
  order.payment_method === 'mp'
  && order.payment_status === 'pendiente'
  && Boolean(order.mp_external_reference)
  && mercadopago.isConfigured();

/** Una consulta a MP por compra. Con pago aprobado lo salda (un monto que no cierra retiene). */
const inspectPurchase = async (reference) => {
  const { state, payment } = await checkPaymentState(reference);
  if (state === PAYMENT_STATE.none) return CANCEL_OUTCOME.released;
  if (state !== PAYMENT_STATE.approved) return CANCEL_OUTCOME.held;

  const settled = await settleApprovedPayment(payment);
  if (settled > 0) invalidateProducts();
  return settled === AMOUNT_MISMATCH ? CANCEL_OUTCOME.held : CANCEL_OUTCOME.paid;
};

/** Estado de una orden MP ya bloqueada → qué hacer con ella. */
const lockedOrderState = (order) => {
  if (!order) return 'not_found';
  if (order.payment_method !== 'mp') return 'not_mp';
  if (RELEASED_STATUSES.includes(order.payment_status)) return 'already_released';
  return order.payment_status === 'pendiente' ? 'cancelled' : 'paid';
};

/**
 * Cancela UNA orden (POST /:id/cancel). El caller ya verificó existencia y dueño.
 * @returns {Promise<'held'|'paid'|'not_found'|'not_mp'|'already_released'|'cancelled'>}
 */
const cancelMpOrder = async (order) => {
  if (canAskMercadoPago(order)) {
    const outcome = await inspectPurchase(order.mp_external_reference);
    if (outcome !== CANCEL_OUTCOME.released) return outcome;
  }
  const state = await withTransaction('cancel_mp_order', async (client) => {
    const locked = await Order.findByIdForUpdate(client, order.id);
    const lockedState = lockedOrderState(locked);
    if (lockedState === 'cancelled') await Order.cancelLockedPending(client, [locked]);
    return lockedState;
  });
  if (state === 'cancelled') invalidateProducts();
  return state;
};

const groupPendingByPurchase = (orders) => {
  const direct = [];
  const groups = new Map();
  for (const order of orders) {
    if (!canAskMercadoPago(order)) {
      direct.push(String(order.id));
      continue;
    }
    const ids = groups.get(order.mp_external_reference) || [];
    ids.push(String(order.id));
    groups.set(order.mp_external_reference, ids);
  }
  return { direct, groups };
};

/** Consulta MP por cada compra distinta (en serie: un carrito trae 1 compra, rara vez más). */
const inspectPendingPurchases = async (pending) => {
  const { direct, groups } = groupPendingByPurchase(pending);
  const releasable = [...direct];
  const outcomes = [];
  for (const [reference, ids] of groups) {
    const outcome = await inspectPurchase(reference);
    outcomes.push(outcome);
    if (outcome === CANCEL_OUTCOME.released) releasable.push(...ids);
  }
  return { releasable, outcomes };
};

/** Cancela las ventas liberables; si alguna se pagó entre medio, el resultado es `paid`. */
const releasePurchases = async (orderIds) => {
  if (orderIds.length === 0) return [];
  const { cancelled, paidMeanwhile } = await withTransaction('cancel_mp_purchases', async (client) => {
    const rows = await Order.findByIdsForUpdate(client, orderIds);
    return {
      cancelled: await Order.cancelLockedPending(client, rows),
      paidMeanwhile: rows.some((row) => row.payment_status === 'pagado'),
    };
  });
  if (cancelled > 0) invalidateProducts();
  return paidMeanwhile ? [CANCEL_OUTCOME.paid] : [];
};

/**
 * Cancela las compras de MP de una lista de ventas (POST /mp-cancel).
 * Ids inexistentes se ignoran; si alguna venta no es del usuario (ni admin) no se toca nada.
 * @returns {Promise<{forbidden: true} | {forbidden: false, outcome: string}>}
 */
const cancelMpPurchases = async (user, orderIds) => {
  const orders = await Order.findByIds(orderIds);
  if (orders.some((order) => !isOrderOwnerOrAdmin(user, order))) return { forbidden: true };

  const mpOrders = orders.filter((order) => order.payment_method === 'mp');
  const outcomes = mpOrders.some((order) => order.payment_status === 'pagado') ? [CANCEL_OUTCOME.paid] : [];
  const pending = mpOrders.filter((order) => order.payment_status === 'pendiente');

  const { releasable, outcomes: lookupOutcomes } = await inspectPendingPurchases(pending);
  outcomes.push(...lookupOutcomes, ...(await releasePurchases(releasable)));
  return { forbidden: false, outcome: mergeOutcomes(outcomes) };
};

module.exports = { CANCEL_OUTCOME, mergeOutcomes, cancelMpOrder, cancelMpPurchases };
