const User = require('../models/User');
const { checkLock, recordFailure, recordSuccess } = require('../middleware/loginBruteforce');
const { checkLimit, recordAttempt } = require('../middleware/emailActionLimiter');
const logger = require('../utils/logger');
const { fetchWithTimeout, isTimeoutError } = require('../utils/fetchWithTimeout');
const { isValidEmail, MAX_EMAIL_LENGTH } = require('../utils/emailValidation');

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

// Tope defensivo de login (no la regla de alta, que es 8-64): Supabase rechaza todo lo que exceda 72 bytes.
const MAX_LOGIN_PASSWORD_LENGTH = 128;

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
  const response = await fetchWithTimeout(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
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
  res.status(503).json({ success: false, code: 'AUTH_UNAVAILABLE', message: 'Servicio de autenticación no disponible' });

// Mismo 503 que `authMiddleware` ante una falla de Auth: el front lo trata como
// transitorio (no cierra la sesión) y `Retry-After` indica cuándo reintentar.
const AUTH_RETRY_AFTER_SECONDS = 2;
const respondAuthTimeout = (res, logEvent) => {
  logger.warn(logEvent);
  res.setHeader('Retry-After', AUTH_RETRY_AFTER_SECONDS);
  return serviceUnavailable(res);
};

const invalidCredentials = (res) =>
  res.status(401).json({ success: false, message: 'Credenciales inválidas' });

// Supabase solo responde estos códigos después de validar la contraseña, así
// que no permiten enumerar cuentas: el front los usa para guiar al usuario.
const SUPABASE_EMAIL_NOT_CONFIRMED = 'email_not_confirmed';
const SUPABASE_CAPTCHA_FAILED = 'captcha_failed';

const loginFailureResponse = (res, supabaseErrorCode) => {
  if (supabaseErrorCode === SUPABASE_EMAIL_NOT_CONFIRMED) {
    return res.status(401).json({
      success: false,
      code: 'EMAIL_NOT_CONFIRMED',
      message: 'Tu cuenta todavía no está confirmada',
    });
  }
  if (supabaseErrorCode === SUPABASE_CAPTCHA_FAILED) {
    return res.status(400).json({
      success: false,
      code: 'CAPTCHA_FAILED',
      message: 'No pudimos verificar que sos una persona. Reintentá.',
    });
  }
  return invalidCredentials(res);
};

// Token de Cloudflare Turnstile: Supabase lo valida si el CAPTCHA está activo en
// su panel; si no lo está, lo ignora. Acotado en largo para no reenviar basura.
const MAX_CAPTCHA_TOKEN_LENGTH = 4096;
const captchaMeta = (captchaToken) =>
  typeof captchaToken === 'string' && captchaToken && captchaToken.length <= MAX_CAPTCHA_TOKEN_LENGTH
    ? { gotrue_meta_security: { captcha_token: captchaToken } }
    : {};

const getFrontendOrigin = () =>
  (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();

const maxAttemptsResponse = (res, retryAfterSeconds) => {
  res.setHeader('Retry-After', retryAfterSeconds);
  return res.status(429).json({
    success: false,
    code: 'MAX_ATTEMPTS_REACHED',
    message: 'Alcanzaste el máximo de 3 intentos. Volvé a intentar en 24 horas.',
    retryAfterSeconds,
  });
};

/**
 * @desc    Login: valida credenciales contra Supabase Auth. El refresh token
 *          queda en una cookie httpOnly (nunca lo lee JS); el access token va
 *          en el body para que el frontend lo guarde solo en memoria.
 * @route   POST /api/auth/login
 */
exports.login = async (req, res) => {
  try {
    const { email, password, captchaToken } = req.body;
    // Un email no-string (objeto/array) rompería email.toLowerCase() en el tracker de fuerza bruta,
    // y uno sin tope de largo se guardaría entero como clave de ese tracker.
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > MAX_EMAIL_LENGTH || password.length > MAX_LOGIN_PASSWORD_LENGTH) {
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

    const { ok, data } = await requestSupabaseToken('password', {
      email,
      password,
      ...captchaMeta(captchaToken),
    });
    if (!ok || !data?.access_token || !data?.refresh_token) {
      // Un captcha fallido o una cuenta sin confirmar no cuentan como intento de adivinar la clave.
      if (data?.error_code !== SUPABASE_CAPTCHA_FAILED && data?.error_code !== SUPABASE_EMAIL_NOT_CONFIRMED) {
        recordFailure(email);
      }
      logger.warn('auth_login_failed_credentials', { supabaseErrorCode: data?.error_code });
      return loginFailureResponse(res, data?.error_code);
    }

    // El id viene en la respuesta de Supabase: evita un seq scan por LOWER(email) en auth.users.
    const profile = data.user?.id ? await User.findById(data.user.id) : null;
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
    if (isTimeoutError(error)) return respondAuthTimeout(res, 'auth_login_timeout');
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
    if (isTimeoutError(error)) return respondAuthTimeout(res, 'auth_refresh_timeout');
    logger.error('auth_refresh_failed', { error: error.message });
    res.status(500).json({ success: false, message: 'No se pudo renovar la sesión' });
  }
};

const supabaseLogout = (accessToken) =>
  fetchWithTimeout(`${SUPABASE_URL}/auth/v1/logout?scope=global`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, apikey: SUPABASE_ANON_KEY },
  });

/**
 * Revoca la sesión en Supabase. Supabase exige un access token vigente para
 * cerrar sesión: si el del cliente venció (o no vino), se obtiene uno nuevo con
 * el refresh token de la cookie. Sin esto, un logout con el access vencido solo
 * borraba la cookie y el refresh token seguía siendo válido para quien lo hubiera robado.
 */
const revokeSession = async (accessToken, refreshToken) => {
  if (accessToken && (await supabaseLogout(accessToken)).ok) return;
  if (!refreshToken) return;

  const { ok, data } = await requestSupabaseToken('refresh_token', { refresh_token: refreshToken });
  if (ok && data?.access_token) await supabaseLogout(data.access_token);
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
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

  if (SUPABASE_URL && SUPABASE_ANON_KEY && (accessToken || refreshToken)) {
    try {
      await revokeSession(accessToken, refreshToken);
    } catch (error) {
      logger.warn('auth_logout_revoke_failed', { error: error.message });
    }
  }

  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Sesión cerrada' });
};

/**
 * @desc    Reenvía el email de confirmación de cuenta. Máximo 3 intentos cada
 *          24hs por email (se cuenta el intento aunque Supabase responda error,
 *          para que no se pueda eludir el límite).
 * @route   POST /api/auth/resend-confirmation
 */
exports.resendConfirmation = async (req, res) => {
  try {
    const { email, captchaToken } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Email inválido' });
    }

    const limit = checkLimit('resend_confirmation', email);
    if (!limit.allowed) return maxAttemptsResponse(res, limit.retryAfterSeconds);

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return serviceUnavailable(res);

    recordAttempt('resend_confirmation', email);

    const redirectTo = `${getFrontendOrigin()}/auth/confirm`;
    const response = await fetchWithTimeout(
      `${SUPABASE_URL}/auth/v1/resend?redirect_to=${encodeURIComponent(redirectTo)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ type: 'signup', email, ...captchaMeta(captchaToken) }),
      }
    );

    // No distinguimos "no existe" / "ya confirmado" en la respuesta al cliente
    // (evita filtrar qué emails están registrados); el detalle real va al log.
    if (!response.ok) {
      logger.warn('auth_resend_confirmation_upstream_failed', { status: response.status });
    }

    res.status(200).json({
      success: true,
      message: 'Si la cuenta existe y está pendiente, te reenviamos el email de confirmación.',
    });
  } catch (error) {
    if (isTimeoutError(error)) return respondAuthTimeout(res, 'auth_resend_confirmation_timeout');
    logger.error('auth_resend_confirmation_failed', { error: error.message });
    res.status(500).json({ success: false, message: 'No se pudo reenviar el email' });
  }
};

/**
 * @desc    Envía el email de recuperación de contraseña. Máximo 3 intentos
 *          cada 24hs por email.
 * @route   POST /api/auth/forgot-password
 */
exports.forgotPassword = async (req, res) => {
  try {
    const { email, captchaToken } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Email inválido' });
    }

    const limit = checkLimit('forgot_password', email);
    if (!limit.allowed) return maxAttemptsResponse(res, limit.retryAfterSeconds);

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return serviceUnavailable(res);

    recordAttempt('forgot_password', email);

    const redirectTo = `${getFrontendOrigin()}/auth/reset-password`;
    const response = await fetchWithTimeout(
      `${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, ...captchaMeta(captchaToken) }),
      }
    );

    if (!response.ok) {
      logger.warn('auth_forgot_password_upstream_failed', { status: response.status });
    }

    res.status(200).json({
      success: true,
      message: 'Si la cuenta existe, te enviamos un email para restablecer la contraseña.',
    });
  } catch (error) {
    if (isTimeoutError(error)) return respondAuthTimeout(res, 'auth_forgot_password_timeout');
    logger.error('auth_forgot_password_failed', { error: error.message });
    res.status(500).json({ success: false, message: 'No se pudo enviar el email' });
  }
};
