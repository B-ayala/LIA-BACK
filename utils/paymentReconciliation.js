/**
 * Conciliación con Mercado Pago antes de liberar stock.
 *
 * Liberar una reserva por tiempo (sweep) o por navegación (el comprador vuelve
 * con Atrás) es seguro solo si MP no tiene un pago aprobado o en curso para
 * esa compra: de lo contrario el pago se acredita después y la venta queda
 * `pagado` sin unidad física. Medios diferidos (ticket, transferencia) pueden
 * tardar días, por eso un pago "en curso" retiene el stock hasta un tope.
 */

const mercadopago = require('./mercadopago');
const logger = require('./logger');

const PAYMENT_STATE = {
  approved: 'approved',
  inFlight: 'in_flight',
  none: 'none',
  unknown: 'unknown',
};

const IN_FLIGHT_STATUSES = new Set(['pending', 'in_process', 'authorized', 'in_mediation']);

/** Un pago aprobado manda; si no, uno en curso retiene; si no, no hay nada que esperar. */
const classifyPayments = (payments) => {
  const list = Array.isArray(payments) ? payments : [];
  const approved = list.find((payment) => payment && payment.status === 'approved');
  if (approved) return { state: PAYMENT_STATE.approved, payment: approved };
  if (list.some((payment) => payment && IN_FLIGHT_STATUSES.has(payment.status))) {
    return { state: PAYMENT_STATE.inFlight, payment: null };
  }
  return { state: PAYMENT_STATE.none, payment: null };
};

/** Ids de venta que viajan en la `external_reference` de MP. */
const parseOrderIdsFromReference = (externalReference) =>
  String(externalReference || '').split(',').map((id) => id.trim()).filter(Boolean);

/**
 * Consulta a MP el estado de pago de una compra. Ante un fallo de la API devuelve
 * `unknown`: quien llama debe NO liberar y reintentar más tarde.
 */
const checkPaymentState = async (externalReference) => {
  try {
    return classifyPayments(await mercadopago.searchPaymentsByReference(externalReference));
  } catch (error) {
    logger.warn('mp_payment_lookup_failed', { code: error.code, status: error.status, message: error.message });
    return { state: PAYMENT_STATE.unknown, payment: null };
  }
};

module.exports = {
  PAYMENT_STATE,
  classifyPayments,
  parseOrderIdsFromReference,
  checkPaymentState,
};
