/**
 * Payload de la preferencia de Checkout Pro (pura: sin I/O, testeable).
 *
 * - `external_reference` es UN id de compra (uuid compartido por todas las líneas
 *   del carrito, guardado en `ventas.mp_external_reference`). Antes eran los ids
 *   de venta separados por coma y un carrito grande superaba los 256 caracteres
 *   que acepta MP.
 * - Se excluyen los medios de pago diferidos (efectivo en ticket / cajero): un
 *   pago "pendiente" de esos tardaba días en acreditarse y retenía el stock
 *   reservado todo ese tiempo. Con tarjeta / dinero en cuenta el resultado es
 *   inmediato y la reserva se resuelve en minutos.
 */

const MP_EXPIRY_MINUTES = 15;
const MS_PER_MINUTE = 60 * 1000;
const MAX_TITLE_LENGTH = 256;
const CURRENCY = 'ARS';
const DEFERRED_PAYMENT_TYPES = Object.freeze([{ id: 'ticket' }, { id: 'atm' }]);

const getFrontendOrigin = () =>
  (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();

const toMpItem = (item) => ({
  title: String(item.productName).slice(0, MAX_TITLE_LENGTH),
  quantity: item.quantity,
  unit_price: Number(item.unitPrice),
  currency_id: CURRENCY,
  picture_url: item.productImage || undefined,
});

/**
 * @param {{buyerName: string, buyerEmail: string, items: object[], shippingCost: number,
 *   purchaseId: string}} order líneas ya valorizadas por el servidor.
 * @param {{origin?: string, webhookUrl?: string, now?: number}} [options]
 */
const buildPreferencePayload = (order, options = {}) => {
  const origin = options.origin || getFrontendOrigin();
  const webhookUrl = options.webhookUrl === undefined ? process.env.MP_WEBHOOK_URL : options.webhookUrl;
  const now = options.now ?? Date.now();
  const resultUrl = `${origin}/checkout/result`;

  const mpItems = order.items.map(toMpItem);
  const surcharge = Number.isFinite(Number(order.shippingCost)) ? Number(order.shippingCost) : 0;
  if (surcharge > 0) {
    mpItems.push({ title: 'Envío', quantity: 1, unit_price: surcharge, currency_id: CURRENCY });
  }

  const preference = {
    items: mpItems,
    payer: { name: String(order.buyerName).trim(), email: String(order.buyerEmail).trim() },
    back_urls: { success: resultUrl, pending: resultUrl, failure: resultUrl },
    external_reference: String(order.purchaseId),
    payment_methods: { excluded_payment_types: DEFERRED_PAYMENT_TYPES.map((type) => ({ ...type })) },
    expires: true,
    expiration_date_to: new Date(now + MP_EXPIRY_MINUTES * MS_PER_MINUTE).toISOString(),
  };

  // MP rechaza auto_return si back_urls.success no es una URL pública (HTTPS):
  // en localhost devuelve 400 "auto_return invalid". Solo lo activamos en prod.
  if (resultUrl.startsWith('https://')) preference.auto_return = 'approved';
  if (webhookUrl) preference.notification_url = webhookUrl;
  return preference;
};

module.exports = { MP_EXPIRY_MINUTES, buildPreferencePayload };
