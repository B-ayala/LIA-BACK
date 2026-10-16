const { Pool } = require('pg');

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

// Verificar conexión
pool.on('connect', () => {
  console.log(`📡 PostgreSQL conectado a ${process.env.DB_HOST}:${process.env.DB_PORT}`);
});

pool.on('error', (err) => {
  console.error('❌ Error en el pool de PostgreSQL:', err.message);
  isConnected = false;
});

const connectDB = async (retries = 3) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      console.log('✓ Conexión a PostgreSQL/Supabase establecida correctamente');
      
      // Verificar que la tabla profiles existe
      const tableCheck = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'profiles'
        );
      `);
      
      if (!tableCheck.rows[0].exists) {
        console.warn('⚠️ Tabla profiles no existe. Ejecuta: npm run init-db');
      } else {
        console.log('✓ Tabla profiles verificada');
      }
      
      client.release();
      isConnected = true;
      return pool;
    } catch (error) {
      console.error(`\n❌ Intento de conexión ${attempt}/${retries} fallido:`);
      console.error(`   Host: ${process.env.DB_HOST}`);
      console.error(`   Port: ${process.env.DB_PORT}`);
      console.error(`   Usuario: ${process.env.DB_USER}`);
      console.error(`   Mensaje: ${error.message || 'Sin mensaje'}`);
      console.error(`   Código: ${error.code || 'UNKNOWN'}`);
      if (error.detail) console.error(`   Detalle: ${error.detail}`);
      
      if (attempt < retries) {
        console.log(`   ⏳ Reintentando en 2 segundos...\n`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.error(`\n❌ No se pudo conectar a PostgreSQL después de ${retries} intentos`);
        console.error('\n📋 Checklist de diagnóstico:');
        console.error('   1. ¿Supabase está disponible? → https://status.supabase.com');
        console.error('   2. ¿El archivo .env existe? → Verifica c:/Users/Brian/Desktop/DamianaBella/lia-ecommerce/.env');
        console.error('   3. ¿Las credenciales son correctas?');
        console.error(`      - DB_HOST: ${process.env.DB_HOST}`);
        console.error(`      - DB_PORT: ${process.env.DB_PORT}`);
        console.error(`      - DB_USER: ${process.env.DB_USER}`);
        console.error(`      - DB_NAME: ${process.env.DB_NAME}`);
        console.error('   4. ¿La contraseña es correcta? → Verifica en Supabase Dashboard');
        console.error('   5. ¿Hay problema de red? → Intenta ping a Supabase');
        isConnected = false;
        throw error;
      }
    }
  }
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

/** Cierra el pool al apagar el proceso (deploy de Railway envía SIGTERM). */
const closeDB = async () => {
  isConnected = false;
  await pool.end();
};

module.exports = { connectDB, pool, isDBConnected, getPoolStats, closeDB };
