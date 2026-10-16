/**
 * Validaciones de borde del checkout que no dependen de la base.
 *
 * Todo lo que llega en el body de una orden es input del cliente: el precio, el
 * nombre y la imagen se resuelven en el servidor, pero `buyerName`, `unitsConfig`
 * y el id de pago se persisten o se reenvían tal cual. Acá se acotan tipos y
 * largos para que no se guarde JSON arbitrario ni se consulte a Mercado Pago
 * con cualquier cosa.
 */

const MAX_BUYER_NAME_LENGTH = 120;
const MAX_BUYER_EMAIL_LENGTH = 254;
const MAX_UNITS_PER_LINE = 100;
const MAX_VARIANT_KEYS = 20;
const MAX_VARIANT_KEY_LENGTH = 60;
const MAX_VARIANT_VALUE_LENGTH = 100;

// Los ids de pago de Mercado Pago son enteros largos.
const PAYMENT_ID_RE = /^\d{1,20}$/;

// La cuenta de Mercado Pago de la tienda cobra en pesos argentinos.
const EXPECTED_CURRENCY = 'ARS';

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isValidVariantEntry = ([key, value]) =>
  key.length > 0 &&
  key.length <= MAX_VARIANT_KEY_LENGTH &&
  (typeof value === 'string' || typeof value === 'number') &&
  String(value).length <= MAX_VARIANT_VALUE_LENGTH;

/** @returns {string|null} mensaje de error, o null si el nombre y el email tienen un largo razonable. */
const validateBuyerLengths = ({ buyerName, buyerEmail }) => {
  if (String(buyerName).trim().length > MAX_BUYER_NAME_LENGTH) {
    return `El nombre del comprador no puede superar ${MAX_BUYER_NAME_LENGTH} caracteres.`;
  }
  if (String(buyerEmail).length > MAX_BUYER_EMAIL_LENGTH) {
    return 'El email del comprador no es válido.';
  }
  return null;
};

/**
 * `unitsConfig` es una lista de selecciones de variante (talle, color...) por
 * unidad: objetos planos de texto. Cualquier otra forma se rechaza.
 * @returns {string|null} mensaje de error, o null si la forma es válida.
 */
const validateUnitsConfig = (item) => {
  if (item.unitsConfig === undefined || item.unitsConfig === null) return null;

  const { unitsConfig } = item;
  const invalid = `Las variantes elegidas de "${item.productName}" no son válidas (unitsConfig).`;

  if (!Array.isArray(unitsConfig) || unitsConfig.length > Math.min(item.quantity, MAX_UNITS_PER_LINE)) {
    return invalid;
  }
  for (const unit of unitsConfig) {
    if (!isPlainObject(unit)) return invalid;
    const entries = Object.entries(unit);
    if (entries.length > MAX_VARIANT_KEYS || !entries.every(isValidVariantEntry)) return invalid;
  }
  return null;
};

const isValidPaymentId = (paymentId) =>
  (typeof paymentId === 'string' || typeof paymentId === 'number') &&
  PAYMENT_ID_RE.test(String(paymentId));

/**
 * Un pago de Mercado Pago solo puede saldar órdenes si está aprobado, tiene
 * referencia a ellas y fue cobrado en la moneda de la tienda. `currency_id`
 * ausente (respuesta incompleta) no bloquea: el monto se sigue validando aparte.
 */
const isSettleablePayment = (payment) => {
  if (!payment || payment.status !== 'approved' || !payment.external_reference) return false;
  return payment.currency_id === undefined || payment.currency_id === EXPECTED_CURRENCY;
};

module.exports = {
  validateBuyerLengths,
  validateUnitsConfig,
  isValidPaymentId,
  isSettleablePayment,
};
