const dotenv = require('dotenv');
// Cargar variables de entorno ANTES de importar módulos que las usen
dotenv.config();

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const { connectDB, getPoolStats, closeDB } = require('./config/database');
const { corsOptions } = require('./config/cors');
const { concurrencyLimit, concurrencyStats } = require('./middleware/concurrencyLimit');
const { createRateLimit, rateLimitStats } = require('./middleware/rateLimit');
const { securityHeaders } = require('./middleware/securityHeaders');
const { cacheStats } = require('./utils/cache');
const logger = require('./utils/logger');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const cloudinaryRoutes = require('./routes/cloudinaryRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const shippingRoutes = require('./routes/shippingRoutes');
const insightsRoutes = require('./routes/insightsRoutes');
const { expireStaleOrders } = require('./controllers/orderController');

const app = express();

// Railway/Vercel terminan TLS en su proxy: sin esto `req.ip` sería siempre la
// IP del proxy y el rate limit trataría a todo el tráfico como un solo cliente.
app.set('trust proxy', 1);

// Firma de Express en las respuestas: menos información para un atacante.
app.disable('x-powered-by');

// Compresión: el catálogo es JSON muy repetitivo (baja ~70-80%). Menos bytes por
// respuesta = menos tiempo de socket abierto por request bajo carga.
app.use(compression());

// Headers de seguridad en TODA respuesta, incluidas las de error: va antes que
// CORS y que las rutas para que ninguna salida quede sin ellos.
app.use(securityHeaders);

// Middleware
app.use(cors(corsOptions));
// Solo se usa para leer la cookie httpOnly del refresh token (authRoutes):
// no se firma nada acá, Supabase ya emite el refresh token firmado.
app.use(cookieParser());
// Límite explícito de body: un payload gigante consume memoria y CPU de parseo
// antes de llegar a cualquier validación.
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// Rate limit general de la API: techo antiflood por IP/usuario, deliberadamente
// holgado. Los límites finos por endpoint sensible (login, checkout, insights)
// viven en cada archivo de rutas y son los que hacen el trabajo real.
app.use(
  '/api',
  createRateLimit({ name: 'api', windowMs: 60 * 1000, max: 1200 })
);

// Control de concurrencia: sólo N handlers tocan la base a la vez; el resto
// espera en cola acotada y, si se llena, recibe 503 rápido (load shedding).
app.use('/api', concurrencyLimit);

// Rutas
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/cloudinary', cloudinaryRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/admin/insights', insightsRoutes);

// Ruta base
app.get('/', (req, res) => {
  res.json({
    message: 'API MVC con Node.js y PostgreSQL/Supabase',
    version: '1.0.0'
  });
});

// Ruta de health check. Queda fuera del rate limit y del bulkhead a propósito:
// tiene que responder incluso con el servidor saturado, que es justo cuando más
// se necesita leer estas métricas.
app.get('/health', (_req, res) => {
  res.json({
    status: 'OK',
    uptimeSeconds: Math.round(process.uptime()),
    db: getPoolStats(),
    concurrency: concurrencyStats(),
    rateLimit: rateLimitStats(),
    caches: cacheStats(),
  });
});

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada'
  });
});

// Manejo de errores global
app.use((err, req, res, _next) => {
  // Body inválido o más grande que el límite: es un 4xx del cliente, no un 500.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'La solicitud es demasiado grande' });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, code: 'INVALID_JSON', message: 'El cuerpo de la solicitud no es JSON válido' });
  }

  logger.error('unhandled_error', { method: req.method, path: req.originalUrl, error: err.message });
  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'production'
      ? 'Error interno del servidor'
      : err.message
  });
});

const PORT = process.env.PORT || 3000;
const ORDER_SWEEP_INTERVAL_MS = 60 * 1000;
const SHUTDOWN_GRACE_MS = 10 * 1000;

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});

/**
 * Apagado ordenado: Railway manda SIGTERM en cada deploy. Sin esto, las
 * requests en vuelo (incluida una compra a medio confirmar) se cortan de golpe.
 */
const registerShutdown = (server, sweepTimer) => {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown_started', { signal });

    clearInterval(sweepTimer);
    // Red de seguridad: si algo queda colgado, no bloquear el deploy para siempre.
    const forceExit = setTimeout(() => {
      logger.error('shutdown_forced', { afterMs: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExit.unref();

    server.close(async () => {
      try {
        await closeDB();
        logger.info('shutdown_completed', { signal });
        process.exit(0);
      } catch (error) {
        logger.error('shutdown_error', { error: error.message });
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

// Iniciar servidor solo después de conectar a BD
(async () => {
  try {
    // Conectar a PostgreSQL/Supabase
    await connectDB();

    const server = app.listen(PORT, () => {
      logger.info('server_started', { port: PORT, env: process.env.NODE_ENV || 'development' });
    });

    // Debe ser mayor al keep-alive del proxy (Railway usa 60 s) para evitar
    // ECONNRESET esporádicos cuando el proxy reusa una conexión que Node cerró.
    server.keepAliveTimeout = 65 * 1000;
    server.headersTimeout = 70 * 1000;
    // Una request que no termina en 30 s ocupa recursos sin dar valor.
    server.requestTimeout = 30 * 1000;

    // Expira órdenes pendientes vencidas (MP 15 min, transferencia 5 h)
    const sweepTimer = setInterval(expireStaleOrders, ORDER_SWEEP_INTERVAL_MS);
    expireStaleOrders();

    registerShutdown(server, sweepTimer);
  } catch (error) {
    logger.error('server_start_failed', { error: error.message });
    process.exit(1);
  }
})();
