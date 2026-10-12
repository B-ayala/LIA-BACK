/**
 * Salda en la base las ventas de un pago aprobado de Mercado Pago.
 * Lo comparten mp-confirm, el webhook y la conciliación (sweep / cancelación),
 * para que todos registren el `payment_id` y apliquen el mismo control de monto.
 */

const Order = require('../models/Order');
const { parseOrderIdsFromReference } = require('./paymentReconciliation');

// MP cobra al centavo; un peso de margen absorbe redondeos sin dejar saldar con menos.
const PAYMENT_AMOUNT_TOLERANCE = 1;

/**
 * @param {{id: string|number, external_reference: string, transaction_amount: number|string}} payment
 * @returns {Promise<number>} ventas marcadas, o -1 si el monto no coincide con el total.
 */
const settleApprovedPayment = async (payment) => {
  const ids = parseOrderIdsFromReference(payment.external_reference);
  if (ids.length === 0) return 0;
  return Order.markPaidByIds(ids, Number(payment.transaction_amount), PAYMENT_AMOUNT_TOLERANCE, payment.id);
};

module.exports = { settleApprovedPayment };
