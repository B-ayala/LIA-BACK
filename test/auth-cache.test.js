/**
 * H-06 / S-04: caché de autenticación con entradas negativas. Supabase Auth se simula con un `https.request`
 * controlable; los rechazos (4xx) se recuerdan por hash del token, las fallas de infraestructura (5xx, 429,
 * timeout) NO.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');
const { installFakeDatabase, createRes, abs } = require('./helpers/harness');

process.env.CACHE_TTL_AUTH_SECONDS = '30';
process.env.CACHE_TTL_AUTH_REJECTED_SECONDS = '45';

const USER_ID = '44444444-4444-4444-8444-444444444444';
const pool = installFakeDatabase((sql) => {
  if (sql.includes('FROM public.profiles')) return { rows: [{ id: USER_ID, role: 'user', name: 'Ana' }] };
  return undefined;
});

const { authMiddleware, optionalAuth, isClearlyUnusableToken } = require(abs('middleware/authMiddleware.js'));
const { caches, TTL, TtlCache } = require(abs('utils/cache.js'));

const supabase = { calls: [], statusByToken: {}, failWith: null };

https.request = (options, onResponse) => {
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => undefined;
  request.end = () => {
    const token = (options.headers.Authorization || '').replace('Bearer ', '');
    supabase.calls.push(token);
    if (supabase.failWith) {
      request.emit('error', supabase.failWith);
      return;
    }
    const response = new EventEmitter();
    response.statusCode = supabase.statusByToken[token] ?? 401;
    onResponse(response);
    response.emit('data', JSON.stringify(response.statusCode === 200 ? { id: USER_ID, email: 'ana@example.test' } : { msg: 'x' }));
    response.emit('end');
  };
  return request;
};

const run = async (middleware, token) => {
  const req = { headers: token === null ? {} : { authorization: `Bearer ${token}` } };
  const res = createRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
};

beforeEach(() => {
  supabase.calls = [];
  supabase.statusByToken = {};
  supabase.failWith = null;
  caches.auth.clear();
  caches.authRejected.clear();
  pool.queries.length = 0;
});

describe('caché negativa de tokens rechazados', () => {
  test('un token que Supabase rechaza se consulta UNA vez; el repetido sale de la caché negativa (401)', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { res, nextCalled } = await run(authMiddleware, 'token-falso');
      assert.equal(res.statusCode, 401);
      assert.equal(nextCalled, false);
    }
    assert.equal(supabase.calls.length, 1);
  });

  test('la clave es el hash del token, nunca el token en claro', async () => {
    await run(authMiddleware, 'token-secreto-123');
    const keys = [...caches.authRejected.entries.keys()];
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^token:[0-9a-f]{64}$/);
    assert.ok(!keys.join('').includes('token-secreto-123'));
  });

  test('optionalAuth (rutas públicas) también usa la caché negativa y sigue como anónimo', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { req, nextCalled } = await run(optionalAuth, 'token-falso');
      assert.equal(nextCalled, true);
      assert.equal(req.user, undefined);
    }
    assert.equal(supabase.calls.length, 1);
  });

  test('un 5xx de Supabase NO se cachea como inválido: 503 y el siguiente intento vuelve a consultar', async () => {
    supabase.statusByToken['token-ok'] = 503;
    const failed = await run(authMiddleware, 'token-ok');
    assert.equal(failed.res.statusCode, 503);
    assert.equal(failed.res.body.code, 'AUTH_UNAVAILABLE');
    assert.equal(caches.authRejected.entries.size, 0);

    supabase.statusByToken['token-ok'] = 200;
    const recovered = await run(authMiddleware, 'token-ok');
    assert.equal(recovered.nextCalled, true);
    assert.equal(recovered.req.user.id, USER_ID);
    assert.equal(supabase.calls.length, 2);
  });

  test('un 429 de Supabase tampoco es "token inválido"', async () => {
    supabase.statusByToken['token-ok'] = 429;
    const { res } = await run(authMiddleware, 'token-ok');
    assert.equal(res.statusCode, 503);
    assert.equal(caches.authRejected.entries.size, 0);
  });

  test('un error de red / timeout no se cachea como inválido', async () => {
    supabase.failWith = Object.assign(new Error('supabase auth timeout'), { code: 'ECONNRESET' });
    const { res } = await run(authMiddleware, 'token-ok');
    assert.equal(res.statusCode, 503);
    assert.equal(caches.authRejected.entries.size, 0);
  });

  test('en optionalAuth una falla de infraestructura deja anónimo y no cachea', async () => {
    supabase.statusByToken['token-ok'] = 500;
    const { req, nextCalled } = await run(optionalAuth, 'token-ok');
    assert.equal(nextCalled, true);
    assert.equal(req.user, undefined);
    assert.equal(caches.authRejected.entries.size, 0);
  });

  test('token válido pero sin perfil todavía (alta reciente): 401 sin recordarlo como rechazado', async () => {
    supabase.statusByToken['token-nuevo'] = 200;
    const original = pool.query;
    pool.query = async () => ({ rows: [], rowCount: 0 });
    try {
      const { res } = await run(authMiddleware, 'token-nuevo');
      assert.equal(res.statusCode, 401);
    } finally {
      pool.query = original;
    }
    assert.equal(caches.authRejected.entries.size, 0);
  });

  test('un token válido se cachea (positiva) y no vuelve a Supabase', async () => {
    supabase.statusByToken['token-ok'] = 200;
    await run(authMiddleware, 'token-ok');
    const second = await run(authMiddleware, 'token-ok');
    assert.equal(second.nextCalled, true);
    assert.equal(supabase.calls.length, 1);
  });
});

describe('topes y descarte rápido', () => {
  test('las cachés de auth admiten miles de sesiones y los TTL cumplen el rango pedido', () => {
    assert.ok(caches.auth.maxEntries >= 5000 && caches.auth.maxEntries <= 10000);
    assert.ok(caches.authRejected.maxEntries >= 1000 && caches.authRejected.maxEntries <= 10000);
    assert.ok(TTL.authRejected >= 30000 && TTL.authRejected <= 60000);
  });

  test('una caché con tope no crece sin límite con tokens únicos', () => {
    const rejected = new TtlCache({ name: 'x', maxEntries: 50 });
    for (let index = 0; index < 500; index += 1) rejected.set(`token:${index}`, true, 60000);
    assert.equal(rejected.entries.size, 50);
  });

  test('tokens vacíos, con espacios o caracteres de control ni llegan a Supabase', async () => {
    assert.equal(isClearlyUnusableToken(''), true);
    assert.equal(isClearlyUnusableToken('abc def'), true);
    assert.equal(isClearlyUnusableToken('abc\ndef'), true);
    assert.equal(isClearlyUnusableToken('a'.repeat(5000)), true);
    const { res } = await run(authMiddleware, 'dos palabras');
    assert.equal(res.statusCode, 401);
    assert.equal(supabase.calls.length, 0);
  });
});
