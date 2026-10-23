const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

process.env.LOG_LEVEL = 'error';

const { createCircuitBreaker, CIRCUIT_OPEN_CODE } = require('../../utils/circuitBreaker');
const { laneFor, lanes, concurrencyStats } = require('../../middleware/concurrencyLimit');
const { recordRequest, metricsSnapshot, resetMetrics, recordProcessEvent } = require('../../utils/requestMetrics');
const { requestObserver } = require('../../middleware/requestObserver');
const { maskIp } = require('../../middleware/proxyDiagnostic');
const { runWithRequestId, currentRequestId } = require('../../utils/requestContext');
const { connectRetryDelayMs } = require('../../config/database');
const { TtlCache } = require('../../utils/cache');
const { isClearlyUnusableToken } = require('../../middleware/authMiddleware');
const mercadopago = require('../../utils/mercadopago');

const outage = () => Object.assign(new Error('MP caído'), { status: 503 });
const rejection = () => Object.assign(new Error('no existe'), { status: 404 });

const makeBreaker = (clock) => createCircuitBreaker({
  name: 'test',
  failureThreshold: 3,
  openMs: 1000,
  isFailure: (error) => error.status >= 500,
  now: () => clock.time,
});

const fail = (breaker, error = outage()) => breaker.execute(async () => { throw error; }).catch((e) => e);

test('breaker: tras N fallos seguidos se abre y rechaza al instante sin ejecutar la operación', async () => {
  const clock = { time: 0 };
  const breaker = makeBreaker(clock);
  for (let i = 0; i < 3; i += 1) await fail(breaker);
  assert.equal(breaker.state(), 'open');
  assert.equal(breaker.isAvailable(), false);

  let executed = false;
  const error = await breaker.execute(async () => { executed = true; }).catch((e) => e);
  assert.equal(executed, false);
  assert.equal(error.code, CIRCUIT_OPEN_CODE);
  assert.ok(error.retryAfterSeconds >= 1);
});

test('breaker: un éxito intermedio reinicia la cuenta de fallos', async () => {
  const breaker = makeBreaker({ time: 0 });
  await fail(breaker);
  await fail(breaker);
  await breaker.execute(async () => 'ok');
  await fail(breaker);
  await fail(breaker);
  assert.equal(breaker.state(), 'closed');
});

test('breaker: un rechazo normal (4xx) no cuenta como caída', async () => {
  const breaker = makeBreaker({ time: 0 });
  for (let i = 0; i < 10; i += 1) await fail(breaker, rejection());
  assert.equal(breaker.state(), 'closed');
});

test('breaker: vencido el plazo deja pasar UNA prueba; si sale bien se cierra', async () => {
  const clock = { time: 0 };
  const breaker = makeBreaker(clock);
  for (let i = 0; i < 3; i += 1) await fail(breaker);
  clock.time = 1500;
  assert.equal(breaker.state(), 'half-open');
  assert.equal(breaker.isAvailable(), true);

  let releaseProbe;
  const probe = breaker.execute(() => new Promise((resolve) => { releaseProbe = resolve; }));
  // Con la prueba en vuelo, el resto sigue rechazado.
  assert.equal(breaker.isAvailable(), false);
  const concurrent = await breaker.execute(async () => 'otra').catch((e) => e);
  assert.equal(concurrent.code, CIRCUIT_OPEN_CODE);

  releaseProbe('ok');
  await probe;
  assert.equal(breaker.state(), 'closed');
});

test('breaker: si la prueba falla vuelve a abrirse un plazo completo', async () => {
  const clock = { time: 0 };
  const breaker = makeBreaker(clock);
  for (let i = 0; i < 3; i += 1) await fail(breaker);
  clock.time = 1500;
  await fail(breaker);
  assert.equal(breaker.state(), 'open');
  clock.time = 2400;
  assert.equal(breaker.isAvailable(), false);
  clock.time = 2600;
  assert.equal(breaker.isAvailable(), true);
});

test('mercadopago: expone el estado del circuito (cerrado al arrancar) y su disponibilidad', () => {
  assert.equal(mercadopago.circuitState(), 'closed');
  assert.equal(mercadopago.isAvailable(), true);
  assert.equal(mercadopago.retryAfterSeconds(), 0);
});

test('carriles: cada ruta cae en el bulkhead que corresponde', () => {
  const cases = [
    ['POST', '/orders/mp-webhook', 'webhook'],
    ['POST', '/orders/mp-preference', 'checkout'],
    ['POST', '/orders/transfer', 'checkout'],
    ['POST', '/orders/mp-confirm', 'checkout'],
    ['POST', '/orders/abc/cancel', 'checkout'],
    ['GET', '/orders/user', 'read'],
    ['PATCH', '/orders/abc/confirm-transfer', 'admin'],
    ['POST', '/auth/login', 'auth'],
    ['GET', '/users', 'admin'],
    ['GET', '/admin/insights/sales', 'admin'],
    ['POST', '/cloudinary/sign', 'admin'],
    ['GET', '/products', 'read'],
    ['POST', '/products', 'read'],
    ['GET', '/shipping/quote', 'read'],
  ];
  for (const [method, path, lane] of cases) assert.equal(laneFor(method, path), lane, `${method} ${path}`);
});

test('carriles: el webhook tiene cupo propio y cada carril reporta sus estadísticas', () => {
  const stats = concurrencyStats();
  assert.deepEqual(Object.keys(stats).sort(), ['admin', 'auth', 'checkout', 'read', 'webhook']);
  assert.ok(stats.webhook.maxConcurrent >= 1);
  assert.notEqual(lanes.webhook, lanes.read);
});

test('carriles: saturar uno no consume los slots de otro', async () => {
  const releases = [];
  for (let i = 0; i < lanes.checkout.maxConcurrent; i += 1) releases.push(await lanes.checkout.acquire());
  lanes.checkout.maxQueue = 0;
  assert.equal(await lanes.checkout.acquire(), null, 'checkout lleno rechaza');
  const webhookSlot = await lanes.webhook.acquire();
  const readSlot = await lanes.read.acquire();
  assert.equal(typeof webhookSlot, 'function');
  assert.equal(typeof readSlot, 'function');
  [...releases, webhookSlot, readSlot].forEach((release) => release());
});

test('métricas: percentiles y conteos por clase de status', () => {
  resetMetrics();
  for (let i = 1; i <= 100; i += 1) recordRequest('GET /api/products', 200, i);
  recordRequest('GET /api/products', 503, 5);
  recordProcessEvent('unhandledRejection');
  const snapshot = metricsSnapshot();
  const route = snapshot.routes['GET /api/products'];
  assert.equal(route.count, 101);
  assert.equal(route['2xx'], 100);
  assert.equal(route.errors5xx, 1);
  assert.ok(route.latencyMs.p50 >= 40 && route.latencyMs.p50 <= 60);
  assert.ok(route.latencyMs.p99 >= 95);
  assert.equal(snapshot.process.unhandledRejection, 1);
  resetMetrics();
});

test('métricas: las rutas no ruteadas se agrupan y el Map no crece sin tope', () => {
  resetMetrics();
  for (let i = 0; i < 400; i += 1) recordRequest(`GET /api/ruta-${i}`, 404, 1);
  const keys = Object.keys(metricsSnapshot().routes);
  assert.ok(keys.length <= 151, `${keys.length} rutas`);
  assert.ok(keys.includes('unmatched'));
  resetMetrics();
});

const fakeRequest = (headers = {}, extra = {}) => ({
  method: 'GET', originalUrl: '/api/x?email=a@b.co', url: '/x', baseUrl: '/api', route: { path: '/x' },
  get: (name) => headers[name], ...extra,
});

const fakeResponse = () => {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.setHeader = (name, value) => { res.headers[name] = value; };
  return res;
};

test('observer: asigna X-Request-Id, lo expone en el contexto y registra la métrica al terminar', () => {
  resetMetrics();
  const res = fakeResponse();
  let idInsideHandler;
  requestObserver(fakeRequest(), res, () => { idInsideHandler = currentRequestId(); });
  assert.ok(res.headers['X-Request-Id']);
  assert.equal(idInsideHandler, res.headers['X-Request-Id']);
  res.emit('finish');
  assert.equal(metricsSnapshot().routes['GET /api/x'].count, 1);
  resetMetrics();
});

test('observer: respeta un id entrante con forma segura y descarta uno malicioso', () => {
  const ok = fakeResponse();
  requestObserver(fakeRequest({ 'X-Request-Id': 'abc-12345678' }), ok, () => {});
  assert.equal(ok.headers['X-Request-Id'], 'abc-12345678');

  const bad = fakeResponse();
  requestObserver(fakeRequest({ 'X-Request-Id': 'x\r\nSet-Cookie: a=b' }), bad, () => {});
  assert.notEqual(bad.headers['X-Request-Id'], 'x\r\nSet-Cookie: a=b');
  assert.match(bad.headers['X-Request-Id'], /^[0-9a-f-]{36}$/);
});

test('observer: un 503 (degradación controlada) cuenta en las métricas pero no se loguea como error', () => {
  resetMetrics();
  const logger = require('../../utils/logger');
  const originalError = logger.error;
  const errors = [];
  logger.error = (message) => errors.push(message);
  try {
    const degraded = fakeResponse();
    degraded.statusCode = 503;
    requestObserver(fakeRequest(), degraded, () => {});
    degraded.emit('finish');

    const failed = fakeResponse();
    failed.statusCode = 500;
    requestObserver(fakeRequest(), failed, () => {});
    failed.emit('finish');
  } finally {
    logger.error = originalError;
  }
  assert.deepEqual(errors, ['request_failed'], 'solo el 500 se loguea como error');
  assert.equal(metricsSnapshot().routes['GET /api/x'].errors5xx, 2);
  resetMetrics();
});

test('observer: /health y /ready no entran en las métricas', () => {
  resetMetrics();
  const res = fakeResponse();
  requestObserver(fakeRequest({}, { originalUrl: '/health', url: '/health' }), res, () => {});
  res.emit('finish');
  assert.deepEqual(metricsSnapshot().routes, {});
});

test('contexto: sin request activa no hay id', () => {
  assert.equal(currentRequestId(), undefined);
  assert.equal(runWithRequestId('r-1', () => currentRequestId()), 'r-1');
});

test('diagnóstico de proxy: la IP se enmascara y nunca se loguea completa', () => {
  assert.equal(maskIp('203.0.113.77'), '203.0.x.x');
  assert.equal(maskIp('::ffff:203.0.113.77'), '203.0.x.x');
  assert.equal(maskIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8::x');
  assert.equal(maskIp(undefined), null);
});

test('conexión a la base: el backoff es exponencial, con tope y jitter acotado', () => {
  const noJitter = () => 0.5;
  assert.equal(connectRetryDelayMs(1, noJitter), 2000);
  assert.equal(connectRetryDelayMs(2, noJitter), 4000);
  assert.equal(connectRetryDelayMs(3, noJitter), 8000);
  assert.equal(connectRetryDelayMs(4, noJitter), 10000);
  assert.equal(connectRetryDelayMs(10, noJitter), 10000);
  assert.ok(connectRetryDelayMs(1, () => 0) >= 1600);
  assert.ok(connectRetryDelayMs(1, () => 1) <= 2400);
});

test('caché: isCacheable evita guardar null pero conserva el single-flight', async () => {
  const cache = new TtlCache({ name: 't', maxEntries: 5 });
  let calls = 0;
  const loader = async () => { calls += 1; return null; };
  const options = { isCacheable: (value) => value !== null };
  await Promise.all([cache.getOrSet('k', 1000, loader, options), cache.getOrSet('k', 1000, loader, options)]);
  assert.equal(calls, 1, 'el single-flight colapsa las concurrentes');
  assert.equal(cache.get('k'), undefined, 'null no se guardó');
  await cache.getOrSet('k', 1000, loader, options);
  assert.equal(calls, 2);
});

const fakeJwt = (payload) =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.firma`;

test('token: descarta sin consultar a Supabase lo vencido y lo desmedido; deja pasar el resto', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isClearlyUnusableToken(fakeJwt({ exp: now - 3600 })), true);
  assert.equal(isClearlyUnusableToken('a'.repeat(5000)), true);
  assert.equal(isClearlyUnusableToken(fakeJwt({ exp: now + 3600 })), false);
  assert.equal(isClearlyUnusableToken(fakeJwt({ exp: now - 5 })), false, 'tolera desfase de reloj');
  assert.equal(isClearlyUnusableToken('user-token'), false, 'lo que no es JWT lo decide Supabase');
  assert.equal(isClearlyUnusableToken(fakeJwt({ sub: 'x' })), false, 'sin exp no se puede afirmar');
  assert.equal(isClearlyUnusableToken('a.%%%.c'), false);
});
