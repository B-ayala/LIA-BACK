/**
 * Ruta de la request SIN query string, para logs. La query puede traer PII (por
 * ejemplo `GET /api/orders/user?email=...`) y los logs de la plataforma no deben
 * guardarla.
 */
const pathWithoutQuery = (req) => String(req.originalUrl || req.url || '').split('?')[0];

module.exports = { pathWithoutQuery };
