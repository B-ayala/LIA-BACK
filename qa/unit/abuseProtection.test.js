const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');
const { isValidEmail } = require('../../utils/emailValidation');
const { createBoundedStore } = require('../../utils/boundedStore');
const { requestDeadline } = require('../../middleware/requestDeadline');
const { cloudinaryRequest } = require('../../utils/cloudinaryHttp');
const { isTimeoutError } = require('../../utils/fetchWithTimeout');

process.env.LOG_LEVEL = 'error';

test('email: acepta direcciones normales y rechaza malformadas', () => {
  for (const ok of ['a@b.co', 'nombre.apellido+tag@dominio.com.ar', 'x@sub.dominio.org']) {
    assert.equal(isValidEmail(ok), true, ok);
  }
  for (const bad of ['', 'sin-arroba', 'a@b', 'a@@b.co', 'a b@c.co', 'a@.co', 'a@b..co', 'a@b.', null, undefined, 42, { a: 1 }, ['a@b.co']]) {
    assert.equal(isValidEmail(bad), false, String(bad));
  }
});

test('email: el largo máximo es 254', () => {
  const local = 'a'.repeat(249); // + "@b.co" (5) = 254
  assert.equal(isValidEmail(`${local}@b.co`), true);
  assert.equal(isValidEmail(`${local}a@b.co`), false);
});

test('email (ReDoS): entradas hostiles de 250k caracteres se resuelven en milisegundos', () => {
  const hostile = [`a@${'.'.repeat(250000)} `, `a@${'a.'.repeat(125000)} `, `${'a'.repeat(250000)}@`];
  const startedAt = process.hrtime.bigint();
  for (const input of hostile) assert.equal(isValidEmail(input), false);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(elapsedMs < 50, `tardó ${elapsedMs.toFixed(1)} ms`);
});

test('email (ReDoS): el patrón sin tope de largo sigue siendo lineal en entradas de 254 caracteres', () => {
  const worstCase = `a@${'.'.repeat(250)} `;
  const startedAt = process.hrtime.bigint();
  isValidEmail(worstCase);
  assert.ok(Number(process.hrtime.bigint() - startedAt) / 1e6 < 5);
});

test('boundedStore: al superar el tope descarta las entradas más viejas', () => {
  const store = createBoundedStore({ maxEntries: 3, isExpired: () => false, purgeIntervalMs: 60000 });
  for (const key of ['a', 'b', 'c', 'd', 'e']) store.set(key, { key });
  assert.equal(store.size(), 3);
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('b'), undefined);
  assert.deepEqual(store.get('e'), { key: 'e' });
});

test('boundedStore: purgeExpired borra solo lo vencido', () => {
  const store = createBoundedStore({ maxEntries: 10, isExpired: (record) => record.expired, purgeIntervalMs: 60000 });
  store.set('vivo', { expired: false });
  store.set('vencido', { expired: true });
  store.purgeExpired();
  assert.equal(store.size(), 1);
  assert.ok(store.get('vivo'));
});

const fakeRes = () => {
  const res = new EventEmitter();
  Object.assign(res, {
    headersSent: false,
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  });
  return res;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('requestDeadline: un handler que no responde recibe 503 REQUEST_TIMEOUT con Retry-After', async () => {
  const res = fakeRes();
  let reachedHandler = false;
  requestDeadline(20)({ method: 'GET', originalUrl: '/api/x?token=secreto', url: '/x' }, res, () => { reachedHandler = true; });
  assert.equal(reachedHandler, true);
  await wait(60);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'REQUEST_TIMEOUT');
  assert.ok(res.headers['Retry-After']);
});

test('requestDeadline: una respuesta a tiempo cancela el plazo', async () => {
  const res = fakeRes();
  requestDeadline(20)({ method: 'GET', originalUrl: '/api/x', url: '/x' }, res, () => {});
  res.emit('finish');
  await wait(60);
  assert.equal(res.body, undefined);
});

test('requestDeadline: no pisa una respuesta que ya empezó a enviarse', async () => {
  const res = fakeRes();
  requestDeadline(20)({ method: 'GET', originalUrl: '/api/x', url: '/x' }, res, () => {});
  res.headersSent = true;
  await wait(60);
  assert.equal(res.body, undefined);
});

/** Sustituye https.request por un doble controlable; devuelve lo capturado y un restaurador. */
const stubHttps = (onEnd) => {
  const original = https.request;
  const captured = {};
  https.request = (options, onResponse) => {
    captured.options = options;
    const request = new EventEmitter();
    request.write = () => undefined;
    request.destroy = (error) => request.emit('error', error);
    request.end = () => onEnd(request, onResponse);
    return request;
  };
  return { captured, restore: () => { https.request = original; } };
};

const respondWith = (onResponse, chunks) => {
  const response = new EventEmitter();
  onResponse(response);
  for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
  response.emit('end');
};

test('cloudinaryHttp: la request lleva un plazo total (AbortSignal) y parsea el JSON', async () => {
  const { captured, restore } = stubHttps((_request, onResponse) => respondWith(onResponse, ['{"ok":', 'true}']));
  try {
    const result = await cloudinaryRequest('GET', '/v1_1/x/usage');
    assert.deepEqual(result, { ok: true });
    assert.ok(captured.options.signal instanceof AbortSignal);
    assert.equal(captured.options.signal.aborted, false);
    assert.match(captured.options.headers.Authorization, /^Basic /);
  } finally {
    restore();
  }
});

test('cloudinaryHttp: una respuesta mayor al tope se corta en vez de acumularse en memoria', async () => {
  const oneMb = 'x'.repeat(1024 * 1024);
  const { restore } = stubHttps((_request, onResponse) => respondWith(onResponse, Array(6).fill(oneMb)));
  try {
    await assert.rejects(cloudinaryRequest('GET', '/v1_1/x/resources/image'), /demasiado grande/);
  } finally {
    restore();
  }
});

test('cloudinaryHttp: un cuerpo que no es JSON rechaza', async () => {
  const { restore } = stubHttps((_request, onResponse) => respondWith(onResponse, ['<html>502</html>']));
  try {
    await assert.rejects(cloudinaryRequest('GET', '/v1_1/x/usage'), /no es JSON/);
  } finally {
    restore();
  }
});

test('cloudinaryHttp: con body envía Content-Type y Content-Length', async () => {
  const { captured, restore } = stubHttps((_request, onResponse) => respondWith(onResponse, ['{}']));
  try {
    await cloudinaryRequest('POST', '/v1_1/x/destroy', { body: 'a=1', contentType: 'application/x-www-form-urlencoded' });
    assert.equal(captured.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(captured.options.headers['Content-Length'], 3);
  } finally {
    restore();
  }
});

test('isTimeoutError: reconoce solo el TimeoutError de AbortSignal.timeout', async () => {
  const error = await fetch('http://127.0.0.1:9', { signal: AbortSignal.timeout(1) }).catch((e) => e);
  assert.equal(isTimeoutError(Object.assign(new Error('t'), { name: 'TimeoutError' })), true);
  assert.equal(isTimeoutError(new Error('ECONNRESET')), false);
  assert.equal(isTimeoutError(undefined), false);
  assert.ok(error instanceof Error);
});
