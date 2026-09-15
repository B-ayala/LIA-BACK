const User = require('../models/User');
const { checkLock, recordFailure, recordSuccess } = require('../middleware/loginBruteforce');
const logger = require('../utils/logger');

/**
 * Endpoints de sesión (login/refresh/logout) separados de `userController`
 * (CRUD de usuarios) porque acá el refresh token vive en una cookie httpOnly:
 * nunca llega a JS del frontend, a diferencia del resto de la API que solo usa
 * el access token en el header `Authorization`.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const REFRESH_COOKIE_NAME = 'sb_refresh_token';
const REFRESH_COOKIE_PATH = '/api/auth';
// Ventana deslizante: se resetea en cada login/refresh exitoso. Con el access
// token expirando cada ~1h y el frontend renovándolo ~60s antes de vencer
// (ver authTokenStore.ts), una pestaña activa nunca llega a este límite: solo
// pega si el usuario está 2h sin visitar el sitio (pestaña cerrada o inactiva).
const REFRESH_COOKIE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Front y back viven en dominios distintos en producción (liaa.com.ar vs
 * Railway): sin `SameSite=None` la cookie no viaja en un fetch cross-site. En
 * desarrollo, front y back comparten "site" (localhost, cualquier puerto), así
 * que `Lax` alcanza y evita depender de HTTPS en local.
 */
const refreshCookieOptions = () => ({
  httpOnly: true,
  secure: isProduction(),
  sameSite: isProduction() ? 'none' : 'lax',
  path: REFRESH_COOKIE_PATH,
  maxAge: REFRESH_COOKIE_MAX_AGE_MS,
});

const setRefreshCookie = (res, refreshToken) =>
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());

const clearRefreshCookie = (res) =>
  res.clearCookie(REFRESH_COOKIE_NAME, { path: REFRESH_COOKIE_PATH });

const requestSupabaseToken = async (grantType, body) => {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, data };
};

const buildUserPayload = (profile) => ({
  id: profile.id,
  name: profile.name,
  email: profile.email,
  role: profile.role || 'user',
});

const serviceUnavailable = (res) =>
  res.status(503).json({ success: false, message: 'Servicio de autenticación no disponible' });

const invalidCredentials = (res) =>
  res.status(401).json({ success: false, message: 'Credenciales inválidas' });

/**
 * @desc    Login: valida credenciales contra Supabase Auth. El refresh token
 *          queda en una cookie httpOnly (nunca lo lee JS); el access token va
 *          en el body para que el frontend lo guarde solo en memoria.
 * @route   POST /api/auth/login
 */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email y contraseña son requeridos' });
    }

    const lock = checkLock(email);
    if (lock.locked) {
      res.setHeader('Retry-After', lock.retryAfterSeconds);
      logger.warn('auth_login_locked', { retryAfterSeconds: lock.retryAfterSeconds });
      return res.status(429).json({
        success: false,
        code: 'ACCOUNT_LOCKED',
        message: 'Demasiados intentos fallidos. Esperá antes de volver a intentar.',
      });
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return serviceUnavailable(res);

    const { ok, data } = await requestSupabaseToken('password', { email, password });
    if (!ok || !data?.access_token || !data?.refresh_token) {
      recordFailure(email);
      return invalidCredentials(res);
    }

    const profile = await User.findByEmail(email);
    if (!profile) return invalidCredentials(res);

    recordSuccess(email);
    setRefreshCookie(res, data.refresh_token);

    res.status(200).json({
      success: true,
      data: {
        user: buildUserPayload(profile),
        accessToken: data.access_token,
        expiresIn: data.expires_in,
      },
    });
  } catch (error) {
    logger.error('auth_login_failed', { error: error.message });
    res.status(500).json({ success: false, message: 'No se pudo validar las credenciales' });
  }
};

/**
 * @desc    Renueva el access token usando el refresh token de la cookie
 *          httpOnly. Supabase rota el refresh token en cada uso, así que la
 *          cookie se reemplaza en cada llamada exitosa.
 * @route   POST /api/auth/refresh
 */
exports.refresh = async (req, res) => {
  try {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      return res.status(401).json({ success: false, message: 'No hay sesión activa' });
    }

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return serviceUnavailable(res);

    const { ok, data } = await requestSupabaseToken('refresh_token', { refresh_token: refreshToken });
    if (!ok || !data?.access_token || !data?.refresh_token || !data?.user?.id) {
      clearRefreshCookie(res);
      return res.status(401).json({ success: false, message: 'Sesión expirada, iniciá sesión de nuevo' });
    }

    const profile = await User.findByUserId(data.user.id);
    if (!profile) {
      clearRefreshCookie(res);
      return res.status(401).json({ success: false, message: 'Sesión expirada, iniciá sesión de nuevo' });
    }

    setRefreshCookie(res, data.refresh_token);

    res.status(200).json({
      success: true,
      data: {
        user: buildUserPayload(profile),
        accessToken: data.access_token,
        expiresIn: data.expires_in,
      },
    });
  } catch (error) {
    logger.error('auth_refresh_failed', { error: error.message });
    res.status(500).json({ success: false, message: 'No se pudo renovar la sesión' });
  }
};

/**
 * @desc    Logout: revoca el refresh token en Supabase (best-effort) y borra
 *          la cookie. Nunca falla del lado del cliente: un logout no puede
 *          quedar "trabado" por un error de red hacia Supabase.
 * @route   POST /api/auth/logout
 */
exports.logout = async (req, res) => {
  const authHeader = req.headers.authorization;
  const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

  if (SUPABASE_URL && SUPABASE_ANON_KEY && accessToken) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=global`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY },
      });
    } catch (error) {
      logger.warn('auth_logout_revoke_failed', { error: error.message });
    }
  }

  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Sesión cerrada' });
};
