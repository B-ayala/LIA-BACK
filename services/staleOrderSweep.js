/**
 * Sweep de órdenes pendientes vencidas.
 *
 * Una orden de MP vencida NO se expira a ciegas: antes se le pregunta a MP si hay
 * un pago para esa compra.
 *  - aprobado            → se salda (el comprador pagó justo sobre el plazo).
 *  - en curso / sin saber → se retiene el stock hasta MP_INFLIGHT_MAX_HOURS y se
 *                           reconsulta cada HOLD_RECHECK_MINUTES como mínimo.
 *  - ninguno             → se expira y se devuelve el stock.
 * Las compras marcadas para revisión (`review_reason`, ej. monto que no cierra) no
 * gastan consultas: se expiran recién al pasar el tope y la marca queda para el admin.
 * Las órdenes sin `mp_external_reference` (anteriores a la conciliación) expiran por tiempo.
 *
 * Cada compra se procesa con su propio try/catch y las transferencias en un paso
 * independiente: un error puntual nunca aborta el ciclo entero.
 */

const Order = require('../models/Order');
const mercadopago = require('../utils/mercadopago');
const logger = require('../utils/logger');
const { mapWithConcurrency } = require('../utils/concurrency');
const { createLookupRotation } = require('../utils/lookupRotation');
const { PAYMENT_STATE, checkPaymentState } = require('../utils/paymentReconciliation');
const { settleApprovedPayment, AMOUNT_MISMATCH } = require('../utils/paymentSettlement');
const { reconcileClosedOrdersIfDue } = require('./closedOrderReconciliation');

// Sin medios diferidos (excluidos en la preferencia) un pago en curso se resuelve
// en minutos u horas: 24 h de retención alcanzan y no inmovilizan stock días.
const MP_INFLIGHT_MAX_HOURS = 24;
const HOLD_RECHECK_MINUTES = 5;
const STALE_BATCH_SIZE = 200;
const MP_LOOKUP_CONCURRENCY = 4;
const DEFAULT_MAX_LOOKUPS_PER_SWEEP = 10;
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const ACTION = { settle: 'settle', hold: 'hold', expire: 'expire' };

// Cada consulta a MP puede tardar hasta su timeout (8 s): con 4 en paralelo y 10
// por ciclo el peor caso (~24 s) queda holgado dentro del intervalo de 60 s.
const maxLookupsPerSweep = () => {
  const value = Number.parseInt(process.env.ORDER_SWEEP_MAX_MP_LOOKUPS, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_LOOKUPS_PER_SWEEP;
};

const rotation = createLookupRotation({ minIntervalMs: HOLD_RECHECK_MINUTES * MS_PER_MINUTE });

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
    const group = groups.get(row.mp_external_reference) || { ids: [], oldest: row.created_at, flagged: false };
    group.ids.push(String(row.id));
    group.flagged = group.flagged || Boolean(row.review_reason);
    groups.set(row.mp_external_reference, group);
  }
  return { legacyIds, groups };
};

/** Decide qué hacer con una compra vencida: 'settle' | 'hold' | 'expire'. */
const decideAction = ({ state }, createdAt, now = Date.now()) => {
  if (state === PAYMENT_STATE.approved) return ACTION.settle;
  const mayStillPay = state === PAYMENT_STATE.inFlight || state === PAYMENT_STATE.unknown;
  return mayStillPay && !isPastHoldLimit(createdAt, now) ? ACTION.hold : ACTION.expire;
};

/** Salda un pago aprobado. Solo cuenta como `paid` lo que realmente se marcó. */
const settleGroup = async (reference, payment) => {
  const settled = await settleApprovedPayment(payment);
  if (settled > 0) {
    rotation.forget(reference);
    return { paid: 1 };
  }
  if (settled === AMOUNT_MISMATCH) {
    rotation.forget(reference);
    return { flagged: 1 };
  }
  logger.warn('sweep_settle_noop', { reference, paymentId: String(payment.id) });
  rotation.markChecked(reference);
  return { held: 1 };
};

/** Procesa una compra vencida. Nunca rechaza: un error se loguea y se reintenta en otro ciclo. */
const processGroup = async (reference, group) => {
  try {
    const check = await checkPaymentState(reference);
    const action = decideAction(check, group.oldest);
    if (action === ACTION.settle) return await settleGroup(reference, check.payment);
    if (action === ACTION.hold) {
      rotation.markChecked(reference);
      return { held: 1 };
    }
    rotation.forget(reference);
    return { expireIds: group.ids };
  } catch (error) {
    rotation.markChecked(reference);
    logger.error('sweep_group_failed', { reference, code: error.code, message: error.message });
    return {};
  }
};

/** Compras marcadas para revisión: sin consultas; se expiran al pasar el tope de retención. */
const splitFlaggedGroups = (groups, now) => {
  const lookupReferences = [];
  const flaggedExpiredIds = [];
  let flaggedHeld = 0;
  for (const [reference, group] of groups) {
    if (!group.flagged) lookupReferences.push(reference);
    else if (isPastHoldLimit(group.oldest, now)) flaggedExpiredIds.push(...group.ids);
    else flaggedHeld += 1;
  }
  return { lookupReferences, flaggedExpiredIds, flaggedHeld };
};

const sumResults = (results) => results.reduce((totals, result) => ({
  paid: totals.paid + (result.paid || 0),
  held: totals.held + (result.held || 0),
  flagged: totals.flagged + (result.flagged || 0),
  expireIds: totals.expireIds.concat(result.expireIds || []),
}), { paid: 0, held: 0, flagged: 0, expireIds: [] });

const expireIdsSafely = async (ids) => {
  try {
    return await Order.expireMpByIds(ids);
  } catch (error) {
    logger.error('sweep_expire_mp_failed', { count: ids.length, code: error.code, message: error.message });
    return 0;
  }
};

const sweepStaleMp = async (mpExpiryMinutes, now = Date.now()) => {
  const stale = await Order.findStaleMpOrders(mpExpiryMinutes, STALE_BATCH_SIZE, rotation.recentlyChecked(now));
  const { legacyIds, groups } = groupStaleOrders(stale, mercadopago.isConfigured());
  const { lookupReferences, flaggedExpiredIds, flaggedHeld } = splitFlaggedGroups(groups, now);

  const picked = rotation.pick(lookupReferences, maxLookupsPerSweep(), now);
  const results = await mapWithConcurrency(picked, MP_LOOKUP_CONCURRENCY,
    (reference) => processGroup(reference, groups.get(reference)));
  const totals = sumResults(results);

  const expired = await expireIdsSafely([...legacyIds, ...flaggedExpiredIds, ...totals.expireIds]);
  rotation.pruneOlderThan(MP_INFLIGHT_MAX_HOURS * MS_PER_HOUR, now);
  return { expired, paid: totals.paid, held: totals.held + flaggedHeld, flagged: totals.flagged };
};

const sweepStaleMpSafely = async (mpExpiryMinutes) => {
  try {
    return await sweepStaleMp(mpExpiryMinutes);
  } catch (error) {
    logger.error('sweep_mp_failed', { code: error.code, message: error.message });
    return { expired: 0, paid: 0, held: 0, flagged: 0 };
  }
};

const expireTransfersSafely = async (transferExpiryHours) => {
  try {
    return await Order.expireStaleTransfers(transferExpiryHours);
  } catch (error) {
    logger.error('sweep_transfer_failed', { code: error.code, message: error.message });
    return 0;
  }
};

/**
 * Un ciclo completo: MP vencidas, transferencias vencidas y (cada 15 min) conciliación
 * de compras cerradas. Cada paso es independiente y nunca rechaza.
 * @returns {Promise<{mp: number, transfer: number, paid: number, held: number, flagged: number,
 *   reconciled: number}>}
 */
const sweepStaleOrders = async ({ mpExpiryMinutes, transferExpiryHours }) => {
  const { expired, paid, held, flagged } = await sweepStaleMpSafely(mpExpiryMinutes);
  const transfer = await expireTransfersSafely(transferExpiryHours);
  const reconciled = await reconcileClosedOrdersIfDue();
  return { mp: expired, transfer, paid, held, flagged, reconciled };
};

module.exports = {
  sweepStaleOrders,
  decideAction,
  isPastHoldLimit,
  groupStaleOrders,
  splitFlaggedGroups,
  MP_INFLIGHT_MAX_HOURS,
  HOLD_RECHECK_MINUTES,
};
