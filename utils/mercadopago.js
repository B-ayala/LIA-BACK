/**
 * Cliente mínimo de la API REST de Mercado Pago.
 * Requiere MP_ACCESS_TOKEN en el entorno (Access Token del vendedor).
 */

const crypto = require('crypto');

const MP_API_BASE = 'https://api.mercadopago.com';

// Sin timeout, un `fetch` colgado deja la request de Express (y, en el caso de
// createPreference, las órdenes ya reservadas) esperando indefinidamente en vez
// de fallar rápido hacia el manejo de error que ya existe (compensación /
// respuesta controlada). 8s dan margen a la API de MP sin sumar una espera
// perceptible sobre los 10s de statement_timeout de la DB.
const MP_REQUEST_TIMEOUT_MS = 8000;

// Tolera valores pegados con comillas en el .env (mismo criterio que cloudinaryController)
const getAccessToken = () =>
  (process.env.MP_ACCESS_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');

const isConfigured = () => Boolean(getAccessToken());

const mpRequest = async (path, options = {}) => {
  let response;
  try {
    response = await fetch(`${MP_API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAccessToken()}`,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(MP_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // `AbortSignal.timeout` dispara un `TimeoutError`; se re-envuelve con un
    // código propio para que el caller lo distinga de un rechazo de MP (4xx/5xx)
    // o de un corte de red, y lo loguee como lo que es: la API no respondió a tiempo.
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      const timeoutError = new Error(`Mercado Pago no respondió en ${MP_REQUEST_TIMEOUT_MS}ms`);
      timeoutError.code = 'MP_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      (data && data.message) || `Mercado Pago respondió ${response.status}`
    );
    error.status = response.status;
    throw error;
  }

  return data;
};

/** Crea una preferencia de checkout. Devuelve el objeto preference (incluye init_point). */
const createPreference = (preference) =>
  mpRequest('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify(preference),
  });

/** Obtiene un pago por id (para verificar estado y external_reference). */
const getPayment = (paymentId) =>
  mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`);

/**
 * Verifica la firma `x-signature` de una notificación de webhook.
 *
 * Mercado Pago firma con HMAC-SHA256 sobre el manifest
 *   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 * usando la clave secreta del webhook (panel de MP → Webhooks).
 *
 * Si `MP_WEBHOOK_SECRET` no está configurada devuelve `null` ("no verificable"),
 * y el caller decide: hoy el webhook igual revalida el pago contra la API de MP,
 * así que sin secreto sigue siendo seguro, solo menos estricto.
 *
 * @returns {boolean|null} true/false si se pudo verificar, null si no hay secreto.
 */
const verifyWebhookSignature = ({ signatureHeader, requestId, dataId }) => {
  const secret = (process.env.MP_WEBHOOK_SECRET || '').trim().replace(/^['"]|['"]$/g, '');
  if (!secret) return null;
  if (!signatureHeader || !dataId) return false;

  // Formato: "ts=1704908010,v1=618c85345248dd820d5fd456117c2ab2ef8eda45a0282ff693eac24131a5e839"
  const parts = String(signatureHeader).split(',').reduce((acc, chunk) => {
    const [key, value] = chunk.split('=');
    if (key && value) acc[key.trim()] = value.trim();
    return acc;
  }, {});

  const { ts, v1 } = parts;
  if (!ts || !v1) return false;

  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId || ''};ts:${ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');

  // Comparación en tiempo constante: una comparación normal filtra por timing
  // cuántos bytes iniciales acertó un atacante que itere sobre la firma.
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(v1, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
};

module.exports = { isConfigured, createPreference, getPayment, verifyWebhookSignature };
