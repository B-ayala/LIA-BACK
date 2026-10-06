/**
 * Middleware de autenticación para Supabase
 *
 * Uso en rutas protegidas:
 * router.get('/protected', authMiddleware, controllerFunction)
 */

const https = require('https');
const crypto = require('crypto');
const { pool } = require('../config/database');
const { caches, TTL } = require('../utils/cache');
const logger = require('../utils/logger');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

/**
 * Clave de caché del token: SHA-256, nunca el token en claro. Aunque la caché
 * es en memoria, un dump de proceso o un log accidental no debe filtrar
 * credenciales reutilizables.
 */
const tokenCacheKey = (token) => `token:${crypto.createHash('sha256').update(token).digest('hex')}`;

/**
 * Verifica el access token contra Supabase Auth (GET /auth/v1/user).
 * Supabase valida firma, expiración y revocación, y devuelve el usuario.
 * @returns {Promise<{id: string}|null>} usuario verificado, o null si el token no es válido.
 */
const SUPABASE_VERIFY_TIMEOUT_MS = 3000;

const verifySupabaseToken = (token) =>
  new Promise((resolve, reject) => {
    const { hostname, pathname } = new URL(`${SUPABASE_URL}/auth/v1/user`);
    const request = https.request(
      {
        hostname,
        path: pathname,
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) return resolve(null);
          try {
            const user = JSON.parse(data);
            resolve(user && user.id ? user : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    // Sin timeout, un Supabase Auth lento deja colgada cada request autenticada ocupando un slot del bulkhead.
    request.setTimeout(SUPABASE_VERIFY_TIMEOUT_MS, () => request.destroy(new Error('supabase auth timeout')));
    request.on('error', reject);
    request.end();
  });

/**
 * Resuelve el usuario de la request: verifica el token contra Supabase y lee su
 * rol de `profiles`.
 * @returns {Promise<object|null>} usuario de la request, o null si el token no vale.
 */
const resolveRequestUser = async (token) => {
  const supabaseUser = await verifySupabaseToken(token);
  if (!supabaseUser) return null;

  const result = await pool.query(
    'SELECT id, role, name FROM public.profiles WHERE id = $1',
    [supabaseUser.id]
  );
  if (result.rows.length === 0) return null;

  const profile = result.rows[0];
  return {
    id: profile.id,
    name: profile.name,
    email: supabaseUser.email || null,
    role: profile.role || 'user',
  };
};

/**
 * Igual que `resolveRequestUser`, pero con caché de corta duración y
 * single-flight.
 *
 * Sin esto, CADA request autenticada hace un round trip HTTPS a Supabase Auth
 * más una query a `profiles`: navegar el panel admin dispara decenas de
 * verificaciones idénticas del mismo token y la latencia externa se vuelve el
 * cuello de botella bajo carga.
 *
 * Trade-off explícito: un token revocado puede seguir siendo aceptado hasta
 * `CACHE_TTL_AUTH_SECONDS` (30 s por defecto, `0` desactiva la caché).
 */
const resolveRequestUserCached = async (token) => {
  if (!(TTL.auth > 0)) return resolveRequestUser(token);

  const key = tokenCacheKey(token);
  const cached = caches.auth.get(key);
  if (cached) return cached;

  // Sólo se cachean verificaciones exitosas: un token inválido debe volver a
  // consultarse siempre (no se le regala al atacante una respuesta memorizada).
  const user = await caches.auth.single(key, () => resolveRequestUser(token));
  if (user) caches.auth.set(key, user, TTL.auth);
  return user;
};

const AUTH_RETRY_AFTER_SECONDS = 2;

const authConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Token Bearer del header Authorization, o null si no viene. */
const extractBearerToken = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.substring(7);
};

/**
 * Falla de infraestructura (timeout de Supabase Auth, red, pool de la BD):
 * NO significa que el token sea inválido, así que no se responde 401 (el front
 * cerraría la sesión de un usuario legítimo). Se responde 503 reintentable.
 */
const respondAuthUnavailable = (res, error) => {
  logger.error('auth_unavailable', { error: error.message, code: error.code });
  res.setHeader('Retry-After', String(AUTH_RETRY_AFTER_SECONDS));
  return res.status(503).json({
    success: false,
    code: 'AUTH_UNAVAILABLE',
    message: 'No pudimos validar tu sesión en este momento. Reintentá en unos segundos.',
  });
};

const authMiddleware = async (req, res, next) => {
  if (!authConfigured()) {
    logger.error('auth_not_configured', { missing: 'SUPABASE_URL / SUPABASE_ANON_KEY' });
    return res.status(503).json({
      success: false,
      message: 'Servicio de autenticación no disponible',
    });
  }

  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Token de autenticación requerido',
    });
  }

  let user;
  try {
    user = await resolveRequestUserCached(token);
  } catch (error) {
    // `resolveRequestUser` devuelve null ante un token inválido; si lanza, es infraestructura.
    return respondAuthUnavailable(res, error);
  }

  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Token inválido o expirado',
    });
  }

  req.user = user;
  req.token = token;
  return next();
};

/**
 * Autenticación opcional para endpoints públicos que muestran más a un admin.
 * Sin token, con token inválido o ante una falla de infraestructura la request
 * sigue como anónima (el público siempre ve menos, nunca más). Si el token es
 * válido, deja `req.user` igual que `authMiddleware`.
 */
const optionalAuth = async (req, _res, next) => {
  const token = extractBearerToken(req);
  if (!token || !authConfigured()) return next();

  try {
    const user = await resolveRequestUserCached(token);
    if (user) {
      req.user = user;
      req.token = token;
    }
  } catch (error) {
    logger.warn('optional_auth_degraded', { error: error.message });
  }
  return next();
};

/**
 * Middleware para validar rol de administrador
 * Debe usarse DESPUÉS de authMiddleware
 */
const adminMiddleware = (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Usuario no autenticado'
      });
    }

    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Acceso denegado: se requieren permisos de administrador'
      });
    }

    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error al validar rol',
      error: error.message
    });
  }
};

module.exports = {
  authMiddleware,
  optionalAuth,
  adminMiddleware
};
