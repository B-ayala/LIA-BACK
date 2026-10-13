const { isAllowedOrigin } = require('../config/cors');
const logger = require('../utils/logger');

/**
 * Defensa CSRF para endpoints que se autentican solo con la cookie del refresh
 * token (SameSite=None en producción): un sitio tercero podría disparar el POST
 * desde el navegador del usuario. Los navegadores siempre mandan `Origin` en
 * POST cross-origin, así que alcanza con rechazar los orígenes fuera de la
 * allowlist de CORS. Sin `Origin` (curl, server-to-server) no hay navegador
 * que engañar.
 */
const requireTrustedOrigin = (req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) return next();

  logger.warn('auth_untrusted_origin', { origin, path: req.path });
  return res.status(403).json({ success: false, message: 'Origen no permitido' });
};

module.exports = { requireTrustedOrigin };
