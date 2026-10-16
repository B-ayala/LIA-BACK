/**
 * Conciliación de compras de MP ya cerradas (`expirado` / `cancelado`).
 *
 * Red de seguridad para el pago que MP acredita DESPUÉS de que la reserva se
 * liberó y del que no llegó ni el webhook ni `mp-confirm` (ej. el comprador cerró
 * la pestaña). Corre dentro del sweep como máximo cada 15 min, mira las compras
 * cerradas de las últimas 48 h sin marca de revisión y, si MP tiene un pago
 * aprobado, lo salda con `settleApprovedPayment` (que ya re-descuenta stock o
 * marca `oversold`). Nunca lanza: un fallo se loguea y el sweep sigue.
 */

const OrderPayment = require('../models/OrderPayment');
const mercadopago = require('../utils/mercadopago');
const logger = require('../utils/logger');
const { mapWithConcurrency } = require('../utils/concurrency');
const { createLookupRotation } = require('../utils/lookupRotation');
const { PAYMENT_STATE, checkPaymentState } = require('../utils/paymentReconciliation');
const { settleApprovedPayment } = require('../utils/paymentSettlement');

const MS_PER_MINUTE = 60 * 1000;
const RUN_EVERY_MS = 15 * MS_PER_MINUTE;
const LOOKBACK_HOURS = 48;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MAX_REFERENCES_PER_PASS = 10;
const CANDIDATE_LIMIT = 200;
const LOOKUP_CONCURRENCY = 4;

const rotation = createLookupRotation();
let lastRunAt = 0;

const isDue = (now) => now - lastRunAt >= RUN_EVERY_MS;

/** @returns {Promise<number>} ventas saldadas para esta compra. */
const reconcileReference = async (reference, now) => {
  rotation.markChecked(reference, now);
  try {
    const { state, payment } = await checkPaymentState(reference);
    if (state !== PAYMENT_STATE.approved) return 0;

    const settled = await settleApprovedPayment(payment);
    if (settled > 0) {
      logger.info('closed_order_reconciled', { reference, paymentId: String(payment.id), settled });
    }
    return Math.max(settled, 0);
  } catch (error) {
    logger.error('closed_order_reconciliation_failed', { reference, code: error.code, message: error.message });
    return 0;
  }
};

const runPass = async (now) => {
  const references = await OrderPayment.findRecentlyClosedMpReferences(LOOKBACK_HOURS, CANDIDATE_LIMIT);
  const picked = rotation.pick(references, MAX_REFERENCES_PER_PASS, now);
  const settled = await mapWithConcurrency(picked, LOOKUP_CONCURRENCY,
    (reference) => reconcileReference(reference, now));
  rotation.pruneOlderThan(LOOKBACK_HOURS * MS_PER_HOUR, now);
  return settled.reduce((total, count) => total + count, 0);
};

/**
 * Corre una pasada si ya pasaron 15 min desde la anterior.
 * @returns {Promise<number>} ventas saldadas (0 si no tocaba o falló).
 */
const reconcileClosedOrdersIfDue = async (now = Date.now()) => {
  if (!mercadopago.isConfigured() || !isDue(now)) return 0;
  lastRunAt = now;
  try {
    return await runPass(now);
  } catch (error) {
    logger.error('closed_order_reconciliation_pass_failed', { code: error.code, message: error.message });
    return 0;
  }
};

module.exports = { reconcileClosedOrdersIfDue, RUN_EVERY_MS };
