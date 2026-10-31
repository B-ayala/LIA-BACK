/**
 * Casos de uso de creación de compra. Devuelven `{ status, body }` (lo que
 * `runCheckout` replica por idempotencia), sin conocer `req`/`res`.
 */

const OrderPayment = require('../models/OrderPayment');
const mercadopago = require('../utils/mercadopago');
const logger = require('../utils/logger');
const { buildPreferencePayload } = require('../utils/mpPreference');
const { reserveOrders, releaseOrders } = require('./checkoutReservation');

const HTTP_CREATED = 201;
const HTTP_BAD_GATEWAY = 502;

/** Cuerpo de error del checkout: `{ success: false, code, message, productId?, size?, expectedTotal? }`. */
const failureResult = ({ status, code, message, productId, size, expectedTotal }) => ({
  status,
  body: {
    success: false,
    code,
    message,
    ...(productId !== undefined ? { productId } : {}),
    ...(size ? { size } : {}),
    ...(expectedTotal !== undefined ? { expectedTotal } : {}),
  },
});

/**
 * Guarda la preferencia en las ventas para poder conciliar. No corta el checkout si
 * falla: la compra ya está reservada (con su `mp_external_reference`) y la
 * preferencia creada; solo se pierde el dato informativo y queda un error en logs.
 */
const recordPreferenceId = async (orderIds, preferenceId) => {
  try {
    await OrderPayment.setPreferenceId(orderIds, preferenceId);
  } catch (error) {
    logger.error('mp_preference_id_not_saved', { orderIds, code: error.code, message: error.message });
  }
};

const mpUnavailableResult = () => failureResult({
  status: HTTP_BAD_GATEWAY,
  code: 'MP_UNAVAILABLE',
  message: 'No se pudo conectar con Mercado Pago. Intentá de nuevo o elegí transferencia.',
});

const logPreferenceFailure = (error, orderIds) => {
  if (error.code === 'MP_TIMEOUT') {
    logger.warn('mp_create_preference_timeout', { orderIds });
  } else {
    logger.error('mp_create_preference_failed', { orderIds, status: error.status, message: error.message });
  }
};

/**
 * Reserva y crea la preferencia de Mercado Pago.
 *
 * La llamada HTTP a MP queda FUERA de la transacción a propósito: si se hiciera
 * adentro, cada checkout en curso retendría una conexión del pool durante todo el
 * round trip externo y bastarían unas pocas compras simultáneas para frenar la API.
 */
const buildMpCheckout = async (input) => {
  // Circuito abierto (MP caído): se corta ANTES de reservar, así no se toca stock
  // ni se ocupa una conexión para compensar enseguida. La transferencia sigue disponible.
  if (!mercadopago.isAvailable()) {
    logger.warn('mp_checkout_rejected_circuit_open', { retryAfterSeconds: mercadopago.retryAfterSeconds() });
    return mpUnavailableResult();
  }

  const reservation = await reserveOrders({ ...input, paymentMethod: 'mp' });
  if (!reservation.ok) return failureResult(reservation);

  try {
    // Se le cobra al comprador lo que quedó persistido (precio de la base), no lo del body.
    const preference = await mercadopago.createPreference(buildPreferencePayload({
      buyerName: input.buyerName,
      buyerEmail: input.buyerEmail,
      items: reservation.pricedItems,
      shippingCost: reservation.shippingCost,
      purchaseId: reservation.purchaseId,
    }));
    if (!preference || !preference.init_point) throw new Error('Mercado Pago no devolvió init_point');

    await recordPreferenceId(reservation.orderIds, preference.id);
    return {
      status: HTTP_CREATED,
      body: {
        success: true,
        init_point: preference.init_point,
        order_ids: reservation.orderIds,
        order_number: reservation.orderNumber,
      },
    };
  } catch (error) {
    logPreferenceFailure(error, reservation.orderIds);
    await releaseOrders(reservation.orderIds);
    return mpUnavailableResult();
  }
};

/** Reserva las órdenes de transferencia. */
const buildTransferCheckout = async (input) => {
  const reservation = await reserveOrders({ ...input, paymentMethod: 'transfer' });
  if (!reservation.ok) return failureResult(reservation);
  return {
    status: HTTP_CREATED,
    body: { success: true, order_ids: reservation.orderIds, order_number: reservation.orderNumber },
  };
};

module.exports = { buildMpCheckout, buildTransferCheckout };
