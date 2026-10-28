const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, installFakeSupabaseAuth, startApp } = require('./helpers/harness');

const USER = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'user@example.test' };
const REGISTERED = {
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  email: 'nueva@example.test',
  user_metadata: { terms_version: '2026-10-28' },
};
const DEFAULT_VERSION = '2026-10-28';

let publishedVersion;
let acceptedVersions;
let failInsert;
const pool = installFakeDatabase((sql, params) => {
  if (sql.startsWith('SELECT id, role, name FROM public.profiles')) {
    return { rows: [{ id: params[0], role: 'user', name: 'Test' }] };
  }
  if (sql.includes('FROM public.site_content')) {
    return { rows: publishedVersion === undefined ? [] : [{ version: publishedVersion }] };
  }
  if (sql.includes('FROM public.terms_acceptances')) {
    return { rows: acceptedVersions.includes(params[1]) ? [{ '?column?': 1 }] : [] };
  }
  if (sql.startsWith('INSERT INTO public.terms_acceptances') && failInsert) throw new Error('db down');
  return undefined;
});
installFakeSupabaseAuth({ 'user-token': USER, 'registered-token': REGISTERED });

let app;
before(async () => {
  app = await startApp([['/api/terms', 'routes/termsRoutes.js']]);
});
after(() => app.close());
beforeEach(() => {
  pool.queries.length = 0;
  publishedVersion = undefined;
  acceptedVersions = [];
  failInsert = false;
});

const call = (path, { method = 'GET', token, body } = {}) => fetch(`${app.baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const insertedRow = () => pool.queries.find((query) => query.sql.startsWith('INSERT INTO public.terms_acceptances'));

describe('GET /api/terms/status', () => {
  test('sin login: 401', async () => {
    assert.equal((await call('/api/terms/status')).status, 401);
  });

  test('cuenta sin aceptación: devuelve la versión vigente y accepted=false', async () => {
    const response = await call('/api/terms/status', { token: 'user-token' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.currentVersion, DEFAULT_VERSION);
    assert.equal(body.accepted, false);
  });

  test('con una constancia de la versión vigente: accepted=true', async () => {
    acceptedVersions = [DEFAULT_VERSION];
    const body = await (await call('/api/terms/status', { token: 'user-token' })).json();
    assert.equal(body.accepted, true);
  });

  test('cuenta creada tildando la versión vigente: accepted=true sin constancia aparte', async () => {
    const body = await (await call('/api/terms/status', { token: 'registered-token' })).json();
    assert.equal(body.accepted, true);
  });

  test('si el admin publicó una versión nueva: la aceptación anterior deja de valer', async () => {
    publishedVersion = '2026-11-02';
    acceptedVersions = [DEFAULT_VERSION];
    const body = await (await call('/api/terms/status', { token: 'registered-token' })).json();
    assert.equal(body.currentVersion, '2026-11-02');
    assert.equal(body.accepted, false);
  });

  test('NEGATIVO: una versión publicada con formato raro se ignora y rige la de por defecto', async () => {
    publishedVersion = '<script>alert(1)</script>';
    const body = await (await call('/api/terms/status', { token: 'user-token' })).json();
    assert.equal(body.currentVersion, DEFAULT_VERSION);
  });
});

describe('POST /api/terms/accept', () => {
  test('sin login: 401', async () => {
    assert.equal((await call('/api/terms/accept', { method: 'POST', body: { termsVersion: DEFAULT_VERSION } })).status, 401);
  });

  test('versión vigente: 201 y deja constancia con usuario, email, IP y contexto', async () => {
    const response = await call('/api/terms/accept', { method: 'POST', token: 'user-token', body: { termsVersion: DEFAULT_VERSION } });
    assert.equal(response.status, 201);
    const { params } = insertedRow();
    assert.equal(params[0], USER.id);
    assert.equal(params[1], USER.email);
    assert.equal(params[3], DEFAULT_VERSION);
    assert.ok(params[4], 'guarda la IP');
    assert.equal(params[5], 'reacceptance');
  });

  test('NEGATIVO: una versión que ya no rige responde 409 y no guarda nada', async () => {
    publishedVersion = '2026-11-02';
    const response = await call('/api/terms/accept', { method: 'POST', token: 'user-token', body: { termsVersion: DEFAULT_VERSION } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).currentVersion, '2026-11-02');
    assert.equal(insertedRow(), undefined);
  });

  test('NEGATIVO: body inválido (versión con formato raro, campos de más) responde 400', async () => {
    const bad = await call('/api/terms/accept', { method: 'POST', token: 'user-token', body: { termsVersion: '<b>' } });
    assert.equal(bad.status, 400);
    const extra = await call('/api/terms/accept', {
      method: 'POST', token: 'user-token', body: { termsVersion: DEFAULT_VERSION, userId: 'otro' },
    });
    assert.equal(extra.status, 400);
  });

  test('un fallo de la base responde 500 con mensaje humano', async () => {
    failInsert = true;
    const response = await call('/api/terms/accept', { method: 'POST', token: 'user-token', body: { termsVersion: DEFAULT_VERSION } });
    assert.equal(response.status, 500);
    assert.match((await response.json()).message, /Intentá de nuevo/);
  });
});

describe('POST /api/terms/registration (público)', () => {
  const register = (body) => call('/api/terms/registration', { method: 'POST', body });

  test('sin login: 204 y deja constancia con email, IP y contexto, sin usuario', async () => {
    const response = await register({ email: 'Nueva@Example.test', termsVersion: DEFAULT_VERSION });
    assert.equal(response.status, 204);
    const { params } = insertedRow();
    assert.equal(params[0], null);
    assert.equal(params[1], 'nueva@example.test');
    assert.equal(params[3], DEFAULT_VERSION);
    assert.equal(params[5], 'registration');
  });

  test('NEGATIVO: una versión que no es la vigente responde igual 204 pero no guarda nada', async () => {
    const response = await register({ email: 'nueva@example.test', termsVersion: '1999-01-01' });
    assert.equal(response.status, 204);
    assert.equal(insertedRow(), undefined);
  });

  test('NEGATIVO: email inválido responde 400', async () => {
    assert.equal((await register({ email: 'no-es-un-mail', termsVersion: DEFAULT_VERSION })).status, 400);
  });

  test('un fallo de la base no rompe el registro: igual 204', async () => {
    failInsert = true;
    assert.equal((await register({ email: 'nueva@example.test', termsVersion: DEFAULT_VERSION })).status, 204);
  });
});
