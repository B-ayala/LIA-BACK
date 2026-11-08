/**
 * Cliente mínimo de la API REST de Mercado Pago.
 * Requiere MP_ACCESS_TOKEN en el entorno (Access Token del vendedor).
 */

const crypto = require('crypto');
const { createCircuitBreaker, CIRCUIT_OPEN_CODE } = require('./circuitBreaker');

const MP_API_BASE = 'https://api.mercadopago.com';

// Sin timeout, un `fetch` colgado deja la request de Express (y, en el caso de
// createPreference, las órdenes ya reservadas) esperando indefinidamente en vez
// de fallar rápido hacia el manejo de error que ya existe (compensación /
// respuesta controlada). 8s dan margen a la API de MP sin sumar una espera
// perceptible sobre los 10s de statement_timeout de la DB.
const MP_REQUEST_TIMEOUT_MS = 8000;

// Crear la preferencia es lo único que el comprador espera mirando la pantalla (y con stock ya
// reservado): 5 s. Si MP no contesta se compensa y se ofrece transferencia, en vez de retener 8 s un slot
// del carril de checkout. Expirar una preferencia al cancelar es secundario: plazo aún más corto.
const MP_PREFERENCE_TIMEOUT_MS = 5000;
const MP_EXPIRE_TIMEOUT_MS = 4000;
// Una respuesta EXITOSA que tarda esto cuenta como falla del circuito: cinco seguidas (latencia alta
// sostenida) lo abren sin esperar a que empiecen los timeouts.
const MP_SLOW_CALL_MS = 3000;

// Tolera valores pegados con comillas en el .env (mismo criterio que cloudinaryController)
const getAccessToken = () =>
  (process.env.MP_ACCESS_TOKEN || '').trim().replace(/^['"]|['"]$/g, '');

const isConfigured = () => Boolean(getAccessToken());

const getWebhookSecret = () =>
  (process.env.MP_WEBHOOK_SECRET || '').trim().replace(/^['"]|['"]$/g, '');

const isWebhookSecretConfigured = () => Boolean(getWebhookSecret());

const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

/**
 * ¿La falla indica que MP no está disponible? Timeouts, cortes de red (sin status),
 * 5xx y 429. Un 4xx (pago inexistente, request inválida) es un rechazo normal: la
 * API respondió, no cuenta para abrir el circuito.
 */
const isMpOutage = (error) =>
  error.code === 'MP_TIMEOUT'
  || !error.status
  || error.status >= HTTP_SERVER_ERROR
  || error.status === HTTP_TOO_MANY_REQUESTS;

// Cinco fallos seguidos abren el circuito 30 s: durante ese lapso las operaciones
// que dependen de MP fallan al instante en vez de esperar 8 s cada una.
const breaker = createCircuitBreaker({
  name: 'mercadopago',
  failureThreshold: 5,
  openMs: 30 * 1000,
  slowCallMs: MP_SLOW_CALL_MS,
  isFailure: isMpOutage,
});

/** ¿Vale la pena intentar una operación con MP ahora? (false = circuito abierto). */
const isAvailable = () => breaker.isAvailable();
const retryAfterSeconds = () => breaker.retryAfterSeconds();
const circuitState = () => breaker.state();

const sendMpRequest = async (path, { timeoutMs = MP_REQUEST_TIMEOUT_MS, ...options } = {}) => {
  let response;
  try {
    response = await fetch(`${MP_API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAccessToken()}`,
        ...(options.headers || {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // `AbortSignal.timeout` dispara un `TimeoutError`; se re-envuelve con un
    // código propio para que el caller lo distinga de un rechazo de MP (4xx/5xx)
    // o de un corte de red, y lo loguee como lo que es: la API no respondió a tiempo.
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      const timeoutError = new Error(`Mercado Pago no respondió en ${timeoutMs}ms`);
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

const mpRequest = (path, options) => breaker.execute(() => sendMpRequest(path, options));

const READ_ATTEMPTS = 2;
const READ_RETRY_BASE_MS = 250;
const JITTER_RATIO = 0.5;

/**
 * Solo se reintenta lo que falló RÁPIDO (5xx, 429, corte de red). Un timeout ya
 * consumió los 8 s: reintentarlo duplicaría la espera del usuario en `mp-confirm`.
 */
const isRetriableRead = (error) =>
  error.code !== 'MP_TIMEOUT' && error.code !== CIRCUIT_OPEN_CODE && isMpOutage(error);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reintenta una LECTURA (idempotente) con backoff exponencial y jitter. Nunca usar con escrituras. */
const withReadRetry = async (operation) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= READ_ATTEMPTS || !isRetriableRead(error)) throw error;
      const backoff = READ_RETRY_BASE_MS * 2 ** (attempt - 1);
      await wait(Math.round(backoff * (1 + Math.random() * JITTER_RATIO)));
    }
  }
};

/** Crea una preferencia de checkout. Devuelve el objeto preference (incluye init_point). */
const createPreference = (preference) =>
  mpRequest('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify(preference),
    timeoutMs: MP_PREFERENCE_TIMEOUT_MS,
  });

/**
 * Expira una preferencia: `PUT /checkout/preferences/{id}` con `expires` y `expiration_date_to` ya
 * vencida (endpoint de actualización de preferencias de Checkout Pro). Idempotente. NO se pudo validar
 * contra Mercado Pago real (sin credenciales de prueba en este entorno): ver `expirePreferenceSafely`.
 */
const expirePreference = (preferenceId, payload) =>
  mpRequest(`/checkout/preferences/${encodeURIComponent(preferenceId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
    timeoutMs: MP_EXPIRE_TIMEOUT_MS,
  });

/** Obtiene un pago por id (para verificar estado y external_reference). */
const getPayment = (paymentId) =>
  withReadRetry(() => mpRequest(`/v1/payments/${encodeURIComponent(paymentId)}`));

// Una compra acumula un pago por intento (tarjeta rechazada, reintento…). Sin
// paginar, 50 intentos ordenados del más nuevo al más viejo cubren de sobra un
// checkout real; el pago aprobado o en curso siempre es de los últimos intentos.
const SEARCH_RESULTS_LIMIT = 50;

/**
 * Pagos de MP asociados a una `external_reference` (más recientes primero).
 * Sirve para saber, antes de liberar stock, si hay un pago aprobado o en curso.
 */
const searchPaymentsByReference = async (externalReference) => {
  const query = new URLSearchParams({
    external_reference: externalReference,
    sort: 'date_created',
    criteria: 'desc',
    limit: String(SEARCH_RESULTS_LIMIT),
  });
  const data = await withReadRetry(() => mpRequest(`/v1/payments/search?${query.toString()}`));
  return Array.isArray(data && data.results) ? data.results : [];
};

// Antigüedad máxima (y adelanto máximo por desfase de reloj) del `ts` firmado en una notificación.
const WEBHOOK_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;
// `ts` llega en segundos o en milisegundos según la versión del webhook: por encima de este valor son ms.
const EPOCH_MS_THRESHOLD = 1e11;
const MS_PER_SECOND = 1000;

const isFreshTimestamp = (ts, now) => {
  const value = Number(ts);
  if (!Number.isFinite(value)) return false;
  const tsMs = value > EPOCH_MS_THRESHOLD ? value : value * MS_PER_SECOND;
  return Math.abs(now - tsMs) <= WEBHOOK_SIGNATURE_MAX_AGE_MS;
};

/**
 * Verifica la firma `x-signature` de una notificación de webhook.
 *
 * Mercado Pago firma con HMAC-SHA256 sobre el manifest
 *   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 * usando la clave secreta del webhook (panel de MP → Webhooks).
 *
 * Si `MP_WEBHOOK_SECRET` no está configurada devuelve `null` ("no verificable"),
 * y el caller decide (en producción el webhook falla cerrado, ver `orderController`; en
 * desarrollo sigue, porque igual revalida el pago contra la API de MP). Con secreto,
 * una firma ausente, inválida o con `ts` fuera de `WEBHOOK_SIGNATURE_MAX_AGE_MS` devuelve
 * `false` y el caller debe rechazar (una notificación vieja capturada no se puede reenviar).
 *
 * @param {number} [now] reloj inyectable (ms epoch) para probar la antigüedad.
 * @returns {boolean|null} true/false si se pudo verificar, null si no hay secreto.
 */
const verifyWebhookSignature = ({ signatureHeader, requestId, dataId, now = Date.now() }) => {
  const secret = getWebhookSecret();
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
  if (!crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) return false;
  return isFreshTimestamp(ts, now);
};

module.exports = {
  isConfigured,
  isAvailable,
  retryAfterSeconds,
  circuitState,
  isWebhookSecretConfigured,
  createPreference,
  getPayment,
  searchPaymentsByReference,
  verifyWebhookSignature,
  expirePreference,
  WEBHOOK_SIGNATURE_MAX_AGE_MS,
  MP_PREFERENCE_TIMEOUT_MS,
  MP_SLOW_CALL_MS,
};
