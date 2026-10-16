/**
 * Salda en la base las ventas de un pago de Mercado Pago.
 * Lo comparten mp-confirm, el webhook, el sweep, la cancelación y la
 * conciliación de compras cerradas, para que todos resuelvan las ventas igual,
 * registren el `payment_id`, apliquen el mismo control de monto y marquen
 * `review_reason` cuando algo requiere a un humano.
 */

const OrderPayment = require('../models/OrderPayment');
const logger = require('./logger');
const { isUuid } = require('./uuid');
const { parseOrderIdsFromReference } = require('./paymentReconciliation');
const { REVIEW_REASON, REVERSED_PAYMENT_REASON } = require('./reviewReasons');

// MP cobra al centavo; un peso de margen absorbe redondeos sin dejar saldar con menos.
const PAYMENT_AMOUNT_TOLERANCE = 1;
const AMOUNT_MISMATCH = OrderPayment.AMOUNT_MISMATCH;
// La cuenta de Mercado Pago de la tienda cobra en pesos argentinos.
const EXPECTED_CURRENCY = 'ARS';

/**
 * Ventas de una compra. La referencia nueva es un id de compra guardado en
 * `ventas.mp_external_reference`; las preferencias anteriores mandaban la lista de
 * ids de venta separados por coma, que se sigue aceptando para pagos viejos.
 */
const resolveOrderIds = async (externalReference) => {
  if (!externalReference) return [];
  const ids = await OrderPayment.findIdsByReference(externalReference);
  if (ids.length > 0) return ids;
  return parseOrderIdsFromReference(externalReference).filter(isUuid);
};

const flagAmountMismatch = async (ids, payment, reason) => {
  logger.error('payment_amount_mismatch', {
    paymentId: String(payment.id),
    reference: String(payment.external_reference),
    paidAmount: payment.transaction_amount,
    orderIds: ids,
    reason,
  });
  await OrderPayment.setReviewReason(ids, REVIEW_REASON.amountMismatch, { status: OrderPayment.STATUS_FILTER.unpaid });
};

/**
 * @param {{id: string|number, external_reference: string, transaction_amount: number|string}} payment
 *   pago APROBADO, ya verificado contra la API de MP.
 * @returns {Promise<number>} ventas realmente pasadas a `pagado`, o -1 si el monto
 *   no coincide (o no es un número): no se salda nada y quedan `amount_mismatch`.
 */
const settleApprovedPayment = async (payment) => {
  const ids = await resolveOrderIds(payment.external_reference);
  if (ids.length === 0) return 0;

  // Un monto en otra moneda no es comparable con el total en pesos. `currency_id`
  // ausente (respuesta incompleta) no bloquea: el monto se valida igual abajo.
  if (payment.currency_id !== undefined && payment.currency_id !== EXPECTED_CURRENCY) {
    await flagAmountMismatch(ids, payment, 'currency_differs');
    return AMOUNT_MISMATCH;
  }

  const paidAmount = Number(payment.transaction_amount);
  if (!Number.isFinite(paidAmount)) {
    await flagAmountMismatch(ids, payment, 'invalid_amount');
    return AMOUNT_MISMATCH;
  }

  const marked = await OrderPayment.markPaidByIds(ids, paidAmount, PAYMENT_AMOUNT_TOLERANCE, payment.id);
  if (marked === AMOUNT_MISMATCH) await flagAmountMismatch(ids, payment, 'amount_differs');
  return marked;
};

const isReversedPayment = (payment) =>
  Boolean(payment) && Object.prototype.hasOwnProperty.call(REVERSED_PAYMENT_REASON, payment.status);

/**
 * Pago reembolsado o contracargado (llega por webhook): solo DETECCIÓN. Marca las
 * ventas pagadas con ese pago para que el admin decida; no toca estado ni stock.
 * @returns {Promise<number>} ventas marcadas.
 */
const flagReversedPayment = async (payment) => {
  const reason = REVERSED_PAYMENT_REASON[payment.status];
  const ids = await resolveOrderIds(payment.external_reference);
  if (!reason || ids.length === 0) return 0;

  const flagged = await OrderPayment.setReviewReason(ids, reason, {
    status: OrderPayment.STATUS_FILTER.paid,
    overwrite: true,
    paymentId: payment.id,
  });
  logger.error('payment_reversed', {
    paymentId: String(payment.id), status: payment.status, reference: String(payment.external_reference), flagged,
  });
  return flagged;
};

module.exports = { settleApprovedPayment, flagReversedPayment, isReversedPayment, resolveOrderIds, AMOUNT_MISMATCH };
