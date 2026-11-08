/**
 * Al cancelar una compra de Mercado Pago, la preferencia (link de pago) seguía viva hasta su vencimiento
 * natural (15 min): el comprador podía pagar una orden que ya liberó su stock. Acá se la expira en MP.
 *
 * Es un esfuerzo no bloqueante: la cancelación en la base ya ocurrió y NUNCA depende de esto. Si MP está
 * caído, lento (timeout propio de 4 s) o rechaza el pedido, solo se loguea; si de todos modos el comprador
 * pagara, la conciliación de compras cerradas lo detecta (`closedOrderReconciliation`).
 *
 * ⚠️ No se pudo validar contra Mercado Pago real (sin credenciales de prueba en este entorno): usa el
 * endpoint de actualización de preferencias (`PUT /checkout/preferences/{id}`) con `expires` y
 * `expiration_date_to`. Probarlo con una preferencia de sandbox antes de confiar en él.
 */

const OrderPayment = require('../models/OrderPayment');
const mercadopago = require('../utils/mercadopago');
const logger = require('../utils/logger');
const { buildExpirationPayload } = require('../utils/mpPreference');

const expireOne = async (preferenceId) => {
  try {
    await mercadopago.expirePreference(preferenceId, buildExpirationPayload());
    logger.info('mp_preference_expired', { preferenceId });
  } catch (error) {
    logger.warn('mp_preference_expire_failed', {
      preferenceId, code: error.code, status: error.status, message: error.message,
    });
  }
};

/**
 * Expira las preferencias indicadas que ya no tienen ventas pendientes. No lanza nunca.
 * @param {Array<string|null|undefined>} preferenceIds ids de `ventas.mp_preference_id` (se ignoran vacíos y repetidos).
 */
const expireReleasedPreferences = async (preferenceIds) => {
  try {
    const candidates = [...new Set(preferenceIds.filter(Boolean).map(String))];
    if (candidates.length === 0 || !mercadopago.isConfigured() || !mercadopago.isAvailable()) return;
    const expirable = await OrderPayment.findPreferencesWithoutPendingOrders(candidates);
    await Promise.all(expirable.map(expireOne));
  } catch (error) {
    logger.warn('mp_preference_expire_skipped', { code: error.code, message: error.message });
  }
};

module.exports = { expireReleasedPreferences };
