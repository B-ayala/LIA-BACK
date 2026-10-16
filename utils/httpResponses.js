/** Respuesta de error con la forma estándar de la API: `{ success: false, code, message, ...extra }`. */
const sendError = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, code, message, ...extra });

module.exports = { sendError };
