/**
 * Tareas periódicas y de arranque del módulo de órdenes (las programa server.js).
 */

const IdempotencyKey = require('../models/IdempotencyKey');
const OrderPayment = require('../models/OrderPayment');
const logger = require('../utils/logger');
const { invalidateProducts } = require('../utils/cache');
const { MP_EXPIRY_MINUTES } = require('../utils/mpPreference');
const { sweepStaleOrders } = require('./staleOrderSweep');

// Ventanas de expiración — deben coincidir con las que muestra el frontend
// (MP_EXPIRY_MS / TRANSFER_EXPIRY_MS en admin/pages/Sales). La de MP es la misma
// que la expiración de la preferencia (utils/mpPreference.js).
const TRANSFER_EXPIRY_HOURS = 5;

// Las respuestas idempotentes solo se reutilizan 10 min: un día de retención sobra.
const IDEMPOTENCY_RETENTION_HOURS = 24;

/** Limpieza de claves vencidas. Aislada: si la tabla no existe no frena el sweep de órdenes. */
const purgeIdempotencyKeys = async () => {
  try {
    await IdempotencyKey.purgeOlderThan(IDEMPOTENCY_RETENTION_HOURS);
  } catch (error) {
    logger.warn('idempotency_purge_failed', { code: error.code, message: error.message });
  }
};

const reportSweep = ({ mp, transfer, paid, held, flagged, reconciled }) => {
  // El sweep movió stock: el catálogo cacheado quedó viejo.
  if (mp > 0 || transfer > 0 || paid > 0 || reconciled > 0) invalidateProducts();
  if (mp > 0 || transfer > 0 || paid > 0 || held > 0 || flagged > 0 || reconciled > 0) {
    logger.info('orders_sweep', {
      expiredMp: mp, expiredTransfer: transfer, settledMp: paid, heldMp: held, flaggedMp: flagged, reconciledClosed: reconciled,
    });
  }
};

/** Sweep periódico: expira órdenes pendientes vencidas. Nunca se solapa consigo mismo. */
let sweepRunning = false;
const expireStaleOrders = async () => {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    await purgeIdempotencyKeys();
    reportSweep(await sweepStaleOrders({
      mpExpiryMinutes: MP_EXPIRY_MINUTES,
      transferExpiryHours: TRANSFER_EXPIRY_HOURS,
    }));
  } catch (error) {
    logger.error('orders_sweep_failed', { code: error.code, message: error.message });
  } finally {
    sweepRunning = false;
  }
};

/** Aviso de arranque: sin las migraciones de conciliación, confirmar pagos fallaría. */
const warnIfPaymentMigrationMissing = async () => {
  try {
    const missing = await OrderPayment.findMissingPaymentColumns();
    if (missing.length > 0) {
      logger.error('missing_migration', {
        migrations: [...new Set(missing.map((entry) => entry.migration))],
        missingColumns: missing.map((entry) => entry.column),
      });
    }
  } catch (error) {
    logger.warn('payment_schema_check_failed', { code: error.code, message: error.message });
  }
};

module.exports = { expireStaleOrders, warnIfPaymentMigrationMissing };
