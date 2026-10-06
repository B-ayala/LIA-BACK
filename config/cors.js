/**
 * Configuración de CORS.
 *
 * - Producción: allowlist estricta tomada de FRONTEND_URL (CSV de orígenes).
 * - Desarrollo: además de la allowlist, se acepta cualquier origen local
 *   (localhost / 127.0.0.1 en cualquier puerto), porque Vite cambia de puerto
 *   automáticamente (5173 → 5174 → …) cuando el anterior está ocupado.
 * - Requests sin `origin` (Postman, curl, same-origin) siempre se permiten.
 */

const DEFAULT_ORIGIN = 'http://localhost:5173';

const isDevelopment = () => process.env.NODE_ENV !== 'production';

const getAllowlist = () =>
  (process.env.FRONTEND_URL || DEFAULT_ORIGIN)
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

const isLocalOrigin = (origin) => {
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
};

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (getAllowlist().includes(origin)) return true;
  return isDevelopment() && isLocalOrigin(origin);
};

const corsOptions = {
  origin: (origin, callback) => {
    // callback(null, false) en lugar de Error: evita que CORS rechazado
    // propague al handler global de Express y devuelva 500.
    callback(null, isAllowedOrigin(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'ngrok-skip-browser-warning'],
};

module.exports = { corsOptions, isAllowedOrigin };
