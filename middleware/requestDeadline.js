// Red de seguridad por request: si el handler no respondió a tiempo se corta con
// 503 y se libera el cliente. Cada llamada saliente ya tiene su propio timeout
// (DB 10 s, Mercado Pago 8 s, Auth 5 s, Cloudinary 8 s); esto cubre lo que
// escape de ellos. `server.requestTimeout` NO sirve para esto: solo limita la
// recepción del request, no el tiempo de respuesta.
//
// Limitación: cortar la respuesta no cancela el trabajo del handler, que sigue
// hasta terminar. Por eso no se monta sobre /api/orders: ahí un 503 mientras la
// reserva o el pago se completan en segundo plano confundiría al cliente.

const logger = require('../utils/logger');
const { pathWithoutQuery } = require('../utils/requestPath');

const DEFAULT_DEADLINE_MS = 25 * 1000;
const RETRY_AFTER_SECONDS = 2;

const requestDeadline = (deadlineMs = DEFAULT_DEADLINE_MS) => (req, res, next) => {
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    logger.warn('request_deadline_exceeded', { method: req.method, path: pathWithoutQuery(req), deadlineMs });
    res.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    res.status(503).json({
      success: false,
      code: 'REQUEST_TIMEOUT',
      message: 'La solicitud tardó demasiado. Reintentá en unos segundos.',
    });
  }, deadlineMs);

  const clear = () => clearTimeout(timer);
  res.once('finish', clear);
  res.once('close', clear);
  next();
};

module.exports = { requestDeadline, DEFAULT_DEADLINE_MS };
