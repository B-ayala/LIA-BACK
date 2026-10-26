const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, installFakeSupabaseAuth, startApp } = require('./helpers/harness');
const { isValidUserName, NAME_MAX_LENGTH, NAME_MIN_LENGTH } = require('../utils/userValidation');

const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.test' };
const TARGET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const pool = installFakeDatabase((sql, params) => {
  if (sql.startsWith('SELECT id, role, name FROM public.profiles')) {
    return { rows: [{ id: params[0], role: 'admin', name: 'Admin' }] };
  }
  if (sql.includes('UPDATE public.profiles')) return { rows: [{ id: params[params.length - 1], name: 'x', role: 'user' }] };
  return undefined;
});

installFakeSupabaseAuth({ 'admin-token': { id: ADMIN.id, email: ADMIN.email } });

let app;
before(async () => {
  app = await startApp([
    ['/api/users', 'routes/userRoutes.js'],
    ['/api/auth', 'routes/authRoutes.js'],
  ]);
});
after(() => app.close());

const call = async (method, path, body, headers = {}) => {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const updateUser = (body) =>
  call('PUT', `/api/users/${TARGET_ID}`, body, { Authorization: 'Bearer admin-token' });

describe('isValidUserName', () => {
  test('acepta nombres reales, con tildes, ñ, apóstrofe, punto y guion', () => {
    for (const name of ['Ana', 'María José', "O'Brien", 'José-Luis Núñez', 'Dr. Pérez', '  Brian  ', 'Zoë', '李雷']) {
      assert.equal(isValidUserName(name), true, name);
    }
  });

  test('rechaza basura, HTML, SQL, emojis, números y tipos no string', () => {
    const bad = ['', ' ', 'A', '1234', '<script>alert(1)</script>', "'; DROP TABLE profiles;--", 'Ana 😀', '-Ana', '.Ana', 'Ana_Pérez', 'Ana\nPérez',
      null, undefined, 42, { a: 1 }, ['Ana']];
    for (const name of bad) assert.equal(isValidUserName(name), false, String(name));
  });

  test('límites exactos de largo (2 y 60)', () => {
    assert.equal(isValidUserName('a'.repeat(NAME_MIN_LENGTH - 1)), false);
    assert.equal(isValidUserName('a'.repeat(NAME_MIN_LENGTH)), true);
    assert.equal(isValidUserName('a'.repeat(NAME_MAX_LENGTH)), true);
    assert.equal(isValidUserName('a'.repeat(NAME_MAX_LENGTH + 1)), false);
  });

  test('el largo se mide sin espacios de los bordes', () => {
    assert.equal(isValidUserName(` ${'a'.repeat(NAME_MAX_LENGTH)} `), true);
  });

  test('ReDoS: una entrada hostil de 1 MB se resuelve en milisegundos', () => {
    const startedAt = process.hrtime.bigint();
    assert.equal(isValidUserName(`${'a '.repeat(500000)}1`), false);
    assert.ok(Number(process.hrtime.bigint() - startedAt) / 1e6 < 200);
  });
});

describe('PUT /api/users/:id — nombre', () => {
  test('NEGATIVO: nombre con HTML -> 400 con mensaje de dominio y sin UPDATE', async () => {
    pool.queries.length = 0;
    const { status, body } = await updateUser({ name: '<img src=x onerror=alert(1)>' });
    assert.equal(status, 400);
    assert.match(body.message, /entre 2 y 60 caracteres/);
    assert.equal(pool.queries.some((q) => q.sql.includes('UPDATE public.profiles')), false);
  });

  test('NEGATIVO: nombre de 61 caracteres -> 400', async () => {
    assert.equal((await updateUser({ name: 'f'.repeat(61) })).status, 400);
  });

  test('NEGATIVO: nombre que no es string (objeto/array/número) -> 400 genérico, sin detalle interno', async () => {
    for (const name of [{ $ne: null }, ['a'], 42]) {
      const { status, body } = await updateUser({ name });
      assert.equal(status, 400);
      assert.doesNotMatch(JSON.stringify(body), /TypeError|at\s|node_modules/);
    }
  });

  test('POSITIVO: nombre válido -> 200 y se guarda recortado', async () => {
    pool.queries.length = 0;
    const { status } = await updateUser({ name: '  María José  ' });
    assert.equal(status, 200);
    const update = pool.queries.find((q) => q.sql.includes('UPDATE public.profiles'));
    assert.equal(update.params[0], 'María José');
  });

  test('NEGATIVO (mass assignment): is_owner / id / email en el body no llegan al UPDATE', async () => {
    pool.queries.length = 0;
    const { status } = await updateUser({ name: 'Ana', is_owner: true, id: ADMIN.id, email: 'x@y.co' });
    assert.equal(status, 200);
    const { sql } = pool.queries.find((q) => q.sql.includes('UPDATE public.profiles'));
    assert.doesNotMatch(sql.split('RETURNING')[0], /is_owner|email|id =\s*\$1\b/);
  });
});

describe('POST /api/auth/login — entradas malformadas', () => {
  const login = (body) => call('POST', '/api/auth/login', body, { Origin: 'http://localhost:5173' });

  test('NEGATIVO: contraseña de más de 128 caracteres -> 400', async () => {
    assert.equal((await login({ email: 'a@b.co', password: 'x'.repeat(129) })).status, 400);
  });

  test('NEGATIVO: email/contraseña que no son string -> 400', async () => {
    assert.equal((await login({ email: { $ne: null }, password: 'x' })).status, 400);
    assert.equal((await login({ email: 'a@b.co', password: ['x'] })).status, 400);
  });
});
