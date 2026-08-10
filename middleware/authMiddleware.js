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

const authMiddleware = async (req, res, next) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error('authMiddleware: faltan SUPABASE_URL / SUPABASE_ANON_KEY en el entorno');
      return res.status(503).json({
        success: false,
        message: 'Servicio de autenticación no disponible',
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Token de autenticación requerido',
      });
    }

    const token = authHeader.substring(7);

    const user = await resolveRequestUserCached(token);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Token inválido o expirado',
      });
    }

    req.user = user;
    req.token = token;

    next();
  } catch (error) {
    console.error('authMiddleware: error al validar autenticación:', error.message);
    return res.status(401).json({
      success: false,
      message: 'No se pudo validar la autenticación',
    });
  }
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
  adminMiddleware
};
