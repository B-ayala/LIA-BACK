/**
 * Entorno aislado para los tests de seguridad: nada toca la base real, Supabase
 * ni Mercado Pago. Se reemplazan por dobles ANTES de cargar los módulos de la app,
 * así los middlewares, rutas y controladores que se prueban son los reales.
 *
 * Cada archivo de test corre en su propio proceso (`node --test`), por lo que el
 * estado de módulos y de require.cache no se filtra entre archivos.
 */

const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..');

process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_ANON_KEY = 'anon-test-key';
process.env.CACHE_TTL_AUTH_SECONDS = '0';
process.env.LOG_LEVEL = 'error';

const abs = (relativePath) => require.resolve(path.join(ROOT, relativePath));

/** Reemplaza un módulo del proyecto por un doble (debe llamarse antes del primer require real). */
const stubModule = (relativePath, exports) => {
  const id = abs(relativePath);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

/**
 * Pool falso. `handler(sql, params)` devuelve `{ rows, rowCount }` (o undefined).
 * Registra todas las consultas en `queries` para poder afirmar sobre ellas.
 */
const createFakePool = (handler = () => undefined) => {
  const queries = [];
  const run = async (sql, params = []) => {
    const text = typeof sql === 'string' ? sql : sql.text;
    queries.push({ sql: text, params });
    const result = await handler(text, params);
    return result || { rows: [], rowCount: 0 };
  };
  const pool = {
    queries,
    query: run,
    connect: async () => ({ query: run, release: () => undefined }),
    on: () => undefined,
    options: { max: 1 },
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  };
  return pool;
};

const installFakeDatabase = (handler) => {
  const pool = createFakePool(handler);
  stubModule('config/database.js', {
    pool,
    connectDB: async () => pool,
    isDBConnected: () => true,
    getPoolStats: () => ({}),
    closeDB: async () => undefined,
  });
  return pool;
};

/**
 * Sustituye `https.request` para que la verificación de tokens contra Supabase Auth
 * (`GET /auth/v1/user`) responda según `tokens`: { '<token>': { id, email } }.
 * Cualquier otro token recibe 401, como haría Supabase con uno inválido o revocado.
 */
const installFakeSupabaseAuth = (tokens) => {
  https.request = (options, onResponse) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => undefined;
    request.end = () => {
      const bearer = (options.headers.Authorization || '').replace('Bearer ', '');
      const user = tokens[bearer];
      const response = new EventEmitter();
      response.statusCode = user ? 200 : 401;
      onResponse(response);
      response.emit('data', JSON.stringify(user || { msg: 'invalid' }));
      response.emit('end');
    };
    return request;
  };
};

/** Req/res mínimos para invocar un handler de Express directamente. */
const createRes = () => {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    clearCookie() { return this; },
    cookie() { return this; },
  };
  return res;
};

/** Levanta una app Express con los routers reales montados en su prefijo. */
const startApp = async (mounts) => {
  const express = require('express');
  const cookieParser = require('cookie-parser');
  const cors = require('cors');
  const { corsOptions } = require(abs('config/cors.js'));
  const { securityHeaders } = require(abs('middleware/securityHeaders.js'));

  const app = express();
  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(cors(corsOptions));
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));
  mounts.forEach(([prefix, routerPath]) => app.use(prefix, require(abs(routerPath))));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, message: 'Error interno del servidor' }));

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, close: () => new Promise((resolve) => server.close(resolve)) };
};

module.exports = {
  ROOT,
  abs,
  stubModule,
  createFakePool,
  installFakeDatabase,
  installFakeSupabaseAuth,
  createRes,
  startApp,
};
