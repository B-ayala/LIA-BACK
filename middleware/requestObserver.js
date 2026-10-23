// Observabilidad por request: id de correlación, latencia por ruta y log de
// acceso. Va primero en la cadena para que la duración incluya a todos los
// middlewares (rate limit, cola del bulkhead, auth).
//
// Log de acceso: solo las requests lentas y las 5xx (cada una responde a una
// pregunta operativa). Con ACCESS_LOG_ALL=true se loguean todas, pensado para
// una prueba de carga puntual: en producción multiplicaría el volumen de logs.

const crypto = require('crypto');
const logger = require('../utils/logger');
const { runWithRequestId } = require('../utils/requestContext');
const { recordRequest } = require('../utils/requestMetrics');
const { pathWithoutQuery } = require('../utils/requestPath');

const REQUEST_ID_HEADER = 'X-Request-Id';
// Un id entrante solo se respeta si tiene forma segura: va a headers y a logs.
const INCOMING_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const DEFAULT_SLOW_REQUEST_MS = 1000;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const HTTP_SERVER_ERROR = 500;
// Degradación controlada: cada causa ya se loguea donde ocurre (request_shed, auth_*_timeout,
// request_deadline_exceeded, circuit_opened). Loguear el 503 como error duplicaría las líneas
// bajo un pico y ensuciaría las alertas por errores reales. Sigue contando en las métricas.
const HTTP_SERVICE_UNAVAILABLE = 503;
const SILENT_PATHS = new Set(['/health', '/ready']);

const slowThresholdMs = () => {
  const value = Number.parseInt(process.env.SLOW_REQUEST_MS, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SLOW_REQUEST_MS;
};

const logAllRequests = () => String(process.env.ACCESS_LOG_ALL || '').trim().toLowerCase() === 'true';

const resolveRequestId = (req) => {
  const incoming = req.get('X-Request-Id');
  return incoming && INCOMING_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
};

/** Patrón de ruta (`/api/orders/:id/cancel`), no la URL: mantiene acotada la cardinalidad de las métricas. */
const routeKeyOf = (req) => {
  if (!req.route) return null;
  const pattern = `${req.baseUrl}${req.route.path}`;
  return `${req.method} ${pattern.length > 1 ? pattern.replace(/\/$/, '') : pattern}`;
};

// El listener de `finish` se registra fuera del contexto asíncrono de la request: el id va explícito.
const logCompletion = (req, res, { durationMs, routeKey, requestId }) => {
  const isError = res.statusCode >= HTTP_SERVER_ERROR && res.statusCode !== HTTP_SERVICE_UNAVAILABLE;
  const isSlow = durationMs >= slowThresholdMs();
  if (!isError && !isSlow && !logAllRequests()) return;

  const context = {
    requestId,
    method: req.method,
    path: pathWithoutQuery(req),
    route: routeKey,
    status: res.statusCode,
    durationMs: Math.round(durationMs),
  };
  if (isError) logger.error('request_failed', context);
  else if (isSlow) logger.warn('request_slow', context);
  else logger.info('request_completed', context);
};

const requestObserver = (req, res, next) => {
  const requestId = resolveRequestId(req);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  const startedAt = process.hrtime.bigint();

  res.once('finish', () => {
    if (SILENT_PATHS.has(pathWithoutQuery(req))) return;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
    const routeKey = routeKeyOf(req);
    recordRequest(routeKey, res.statusCode, durationMs);
    logCompletion(req, res, { durationMs, routeKey, requestId });
  });

  runWithRequestId(requestId, next);
};

module.exports = { requestObserver };
