/**
 * Sweep de órdenes pendientes vencidas.
 *
 * Una orden de MP vencida NO se expira a ciegas: antes se le pregunta a MP si hay
 * un pago para esa compra.
 *  - aprobado            → se salda (el comprador pagó justo sobre el plazo).
 *  - en curso / sin saber → se retiene el stock hasta MP_INFLIGHT_MAX_HOURS
 *                           (un ticket o transferencia puede tardar días).
 *  - ninguno             → se expira y se devuelve el stock.
 * Las órdenes sin `mp_external_reference` (anteriores a la conciliación) se expiran por tiempo.
 */

const Order = require('../models/Order');
const mercadopago = require('../utils/mercadopago');
const { PAYMENT_STATE, checkPaymentState } = require('../utils/paymentReconciliation');
const { settleApprovedPayment } = require('../utils/paymentSettlement');

const MP_INFLIGHT_MAX_HOURS = 72;
const STALE_BATCH_SIZE = 200;
// Cada consulta a MP puede tardar hasta su timeout: acotamos cuántas hace un ciclo (el resto va al siguiente).
const MAX_LOOKUPS_PER_SWEEP = 10;
const MS_PER_HOUR = 60 * 60 * 1000;

const isPastHoldLimit = (createdAt, now = Date.now()) =>
  now - new Date(createdAt).getTime() > MP_INFLIGHT_MAX_HOURS * MS_PER_HOUR;

/** Agrupa por compra (external_reference); las órdenes sin referencia se expiran directo. */
const groupStaleOrders = (rows, canLookup) => {
  const legacyIds = [];
  const groups = new Map();
  for (const row of rows) {
    if (!canLookup || !row.mp_external_reference) {
      legacyIds.push(String(row.id));
      continue;
    }
    const group = groups.get(row.mp_external_reference) || { ids: [], oldest: row.created_at };
    group.ids.push(String(row.id));
    groups.set(row.mp_external_reference, group);
  }
  return { legacyIds, groups };
};

/** Decide qué hacer con una compra vencida: 'settle' | 'hold' | 'expire'. */
const decideAction = ({ state }, createdAt) => {
  if (state === PAYMENT_STATE.approved) return 'settle';
  const mayStillPay = state === PAYMENT_STATE.inFlight || state === PAYMENT_STATE.unknown;
  return mayStillPay && !isPastHoldLimit(createdAt) ? 'hold' : 'expire';
};

const sweepStaleMp = async (mpExpiryMinutes) => {
  const stale = await Order.findStaleMpOrders(mpExpiryMinutes, STALE_BATCH_SIZE);
  const { legacyIds, groups } = groupStaleOrders(stale, mercadopago.isConfigured());
  const toExpire = [...legacyIds];
  let paid = 0;
  let held = 0;

  for (const [reference, group] of [...groups].slice(0, MAX_LOOKUPS_PER_SWEEP)) {
    const check = await checkPaymentState(reference);
    const action = decideAction(check, group.oldest);
    if (action === 'settle') {
      await settleApprovedPayment(check.payment);
      paid += 1;
    } else if (action === 'hold') {
      held += 1;
    } else {
      toExpire.push(...group.ids);
    }
  }

  const expired = await Order.expireMpByIds(toExpire);
  return { expired, paid, held };
};

/** @returns {Promise<{mp: number, transfer: number, paid: number, held: number}>} */
const sweepStaleOrders = async ({ mpExpiryMinutes, transferExpiryHours }) => {
  const { expired, paid, held } = await sweepStaleMp(mpExpiryMinutes);
  const transfer = await Order.expireStaleTransfers(transferExpiryHours);
  return { mp: expired, transfer, paid, held };
};

module.exports = { sweepStaleOrders, decideAction, isPastHoldLimit, MP_INFLIGHT_MAX_HOURS };
