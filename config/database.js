const { Pool } = require('pg');
const logger = require('../utils/logger');

const parseIntEnv = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * TLS hacia la base. Por defecto se cifra sin validar el certificado (el pooler de
 * Supabase usa una CA propia que Node no conoce), así que un atacante en la red podría
 * interponerse. Con DB_SSL_CA (PEM de la CA de Supabase; admite "\n" literales) se
 * valida el certificado del servidor.
 */
const buildSslOptions = () => {
  const ca = (process.env.DB_SSL_CA || '').split('\\n').join('\n').trim();
  return ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false };
};

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: buildSslOptions(),
  // Configuración del pool. El techo real lo pone Supabase: su pooler en modo
  // sesión limita el proyecto a 15 clientes y devuelve `EMAXCONNSESSION` al
  // pasarse (verificado en carga con 800 requests concurrentes). Se deja margen
  // para migraciones y psql manual. Subir esto sin subir el pool_size de
  // Supabase sólo cambia un error de cola por un error del servidor.
  max: parseIntEnv('DB_POOL_MAX', 12),
  min: parseIntEnv('DB_POOL_MIN', 2),
  idleTimeoutMillis: parseIntEnv('DB_IDLE_TIMEOUT_MS', 30000),
  connectionTimeoutMillis: parseIntEnv('DB_CONNECTION_TIMEOUT_MS', 5000),
  // Una query colgada mantiene ocupada una conexión del pool y, en carga, se
  // lleva puesto al resto. Con estos timeouts falla rápido y libera el slot.
  statement_timeout: parseIntEnv('DB_STATEMENT_TIMEOUT_MS', 10000),
  query_timeout: parseIntEnv('DB_QUERY_TIMEOUT_MS', 10000),
  keepAlive: true,
});

let isConnected = false;

// Una conexión nueva del pool no es un evento operativo: queda en debug.
pool.on('connect', () => logger.debug('db_pool_connection_opened'));

pool.on('error', (err) => {
  logger.error('db_pool_error', { error: err.message, code: err.code });
  isConnected = false;
});

const CONNECT_RETRIES = 5;
const CONNECT_BASE_DELAY_MS = 2000;
const CONNECT_MAX_DELAY_MS = 10000;
const JITTER_RATIO = 0.2;

/**
 * Espera entre reintentos de conexión: exponencial con tope y jitter. Durante un
 * deploy con solape, la instancia vieja libera sus conexiones en segundos; un
 * intervalo fijo de 2 s agotaba los 3 intentos antes de que eso ocurriera.
 */
const connectRetryDelayMs = (attempt, random = Math.random) => {
  const exponential = Math.min(CONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), CONNECT_MAX_DELAY_MS);
  return Math.round(exponential * (1 + (random() * 2 - 1) * JITTER_RATIO));
};

const verifyProfilesTable = async (client) => {
  const tableCheck = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'profiles'
    );
  `);
  if (!tableCheck.rows[0].exists) logger.warn('db_profiles_table_missing', { hint: 'Ejecutar: npm run init-db' });
};

const connectDB = async (retries = CONNECT_RETRIES) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      try {
        await verifyProfilesTable(client);
      } finally {
        client.release();
      }
      logger.info('db_connected');
      isConnected = true;
      return pool;
    } catch (error) {
      // Sin host ni usuario de la base en el log: la plataforma de logs no es un lugar para esos datos.
      logger.error('db_connect_failed', { attempt, retries, code: error.code || 'UNKNOWN', error: error.message });
      if (attempt === retries) {
        isConnected = false;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, connectRetryDelayMs(attempt)));
    }
  }
  return pool;
};

// Verificar estado de conexión
const isDBConnected = () => {
  return isConnected;
};

/**
 * Estado del pool para el health check: `waiting > 0` sostenido significa que
 * la concurrencia entrante supera a las conexiones disponibles.
 */
const getPoolStats = () => ({
  total: pool.totalCount,
  idle: pool.idleCount,
  waiting: pool.waitingCount,
  max: pool.options.max,
});

/** Cierra el pool al apagar el proceso (el deploy de la plataforma envía SIGTERM). */
const closeDB = async () => {
  isConnected = false;
  await pool.end();
};

const READINESS_TIMEOUT_MS = 2000;

/**
 * Prueba real de que la API puede servir: un `SELECT 1` por el pool, con plazo.
 * Si el pool está agotado o la base no responde, falla en 2 s en vez de colgarse.
 * @returns {Promise<{ok: boolean, latencyMs: number, error?: string}>}
 */
const checkDatabase = async (timeoutMs = READINESS_TIMEOUT_MS) => {
  const startedAt = Date.now();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('readiness timeout')), timeoutMs);
  });
  try {
    await Promise.race([pool.query('SELECT 1'), deadline]);
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: error.message };
  } finally {
    clearTimeout(timer);
  }
};

module.exports = { connectDB, pool, isDBConnected, getPoolStats, closeDB, checkDatabase, connectRetryDelayMs };
