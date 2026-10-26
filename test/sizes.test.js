const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, installFakeSupabaseAuth, startApp } = require('./helpers/harness');

const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.test' };
const USER = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'user@example.test' };
const ROLES = { [ADMIN.id]: 'admin', [USER.id]: 'user' };
const SIZE_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_ID = '22222222-2222-4222-8222-222222222222';
const ROW = {
  id: SIZE_ID, name: 'M', type: 'indumentaria', garment: 'Camisa', measurements: { Pecho: '50' }, active: true,
  created_at: '2026-10-26T00:00:00Z', updated_at: '2026-10-26T00:00:00Z',
};

const state = { duplicate: false };
const seenKeys = new Set();
const uniqueKey = ([name, type, garment]) => [type, (garment ?? '').toLowerCase(), name.toLowerCase()].join('|');

const pool = installFakeDatabase((sql, params) => {
  if (sql.startsWith('SELECT id, role, name FROM public.profiles')) {
    const role = ROLES[params[0]];
    return role ? { rows: [{ id: params[0], role, name: 'Test' }] } : { rows: [] };
  }
  if (sql.startsWith('SELECT id FROM public.talles')) return { rows: params[0].includes(SIZE_ID) ? [{ id: SIZE_ID }] : [] };
  if (sql.includes('FROM public.talles ORDER BY')) return { rows: [ROW] };
  if (sql.startsWith('INSERT INTO public.talles') || sql.startsWith('UPDATE public.talles')) {
    if (state.duplicate) throw Object.assign(new Error('dup'), { code: '23505' });
    if (sql.startsWith('INSERT INTO public.talles')) {
      const key = uniqueKey(params);
      if (seenKeys.has(key)) throw Object.assign(new Error('dup'), { code: '23505' });
      seenKeys.add(key);
    }
    if (sql.startsWith('UPDATE') && params[params.length - 1] === UNKNOWN_ID) return { rows: [] };
    return { rows: [{ ...ROW, name: params[0] === 'XL' ? 'XL' : ROW.name }] };
  }
  if (sql.startsWith('INSERT INTO public.productos')) return { rows: [{ id: 1 }] };
  return undefined;
});
installFakeSupabaseAuth({ 'admin-token': ADMIN, 'user-token': USER });

let app;
before(async () => {
  app = await startApp([['/api/sizes', 'routes/sizeRoutes.js'], ['/api/products', 'routes/productRoutes.js']]);
});
after(() => app.close());

const call = (path, { method = 'GET', token, body } = {}) => fetch(`${app.baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const talleQueries = () => pool.queries.filter((query) => query.sql.includes('public.talles'));

describe('GET /api/sizes', () => {
  test('es público y devuelve los talles en camelCase', async () => {
    const response = await call('/api/sizes');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.data[0], {
      id: SIZE_ID, name: 'M', type: 'indumentaria', garment: 'Camisa', measurements: { Pecho: '50' }, active: true,
      createdAt: ROW.created_at, updatedAt: ROW.updated_at,
    });
    assert.match(response.headers.get('cache-control'), /public, max-age=30/);
  });
});

describe('POST /api/sizes', () => {
  test('sin token 401, usuario común 403', async () => {
    assert.equal((await call('/api/sizes', { method: 'POST', body: { name: 'M', type: 'calzado' } })).status, 401);
    const forbidden = await call('/api/sizes', { method: 'POST', token: 'user-token', body: { name: 'M', type: 'calzado' } });
    assert.equal(forbidden.status, 403);
  });

  test('admin crea el talle: 201 y nombre en mayúsculas', async () => {
    const response = await call('/api/sizes', {
      method: 'POST', token: 'admin-token', body: { name: ' xl ', type: 'indumentaria' },
    });
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.equal(body.data.name, 'XL');
    const insert = pool.queries.find((query) => query.sql.startsWith('INSERT INTO public.talles'));
    assert.deepEqual(insert.params, ['XL', 'indumentaria', null, '{}']);
  });

  test('con prenda: se guarda tal cual la escribe el usuario; vacía se guarda null', async () => {
    const insertParams = () => pool.queries.filter((query) => query.sql.startsWith('INSERT INTO public.talles')).pop().params;
    await call('/api/sizes', { method: 'POST', token: 'admin-token', body: { name: 'm', type: 'indumentaria', garment: '  Saco Sastrero ' } });
    assert.deepEqual(insertParams(), ['M', 'indumentaria', 'Saco Sastrero', '{}']);
    await call('/api/sizes', { method: 'POST', token: 'admin-token', body: { name: 'm', type: 'indumentaria', garment: '   ' } });
    assert.deepEqual(insertParams(), ['M', 'indumentaria', null, '{}']);
  });

  test('prenda de 31 caracteres: 400 sin tocar la base', async () => {
    const queriesBefore = talleQueries().length;
    const response = await call('/api/sizes', {
      method: 'POST', token: 'admin-token', body: { name: 'M', type: 'indumentaria', garment: 'x'.repeat(31) },
    });
    assert.equal(response.status, 400);
    assert.equal(talleQueries().length, queriesBefore);
  });

  test('mismo nombre con otra prenda: 201; misma prenda: 409 SIZE_DUPLICATE', async () => {
    const body = { name: 'M', type: 'indumentaria', garment: 'Saco' };
    seenKeys.clear();
    assert.equal((await call('/api/sizes', { method: 'POST', token: 'admin-token', body })).status, 201);
    assert.equal((await call('/api/sizes', { method: 'POST', token: 'admin-token', body: { ...body, garment: 'Camisa' } })).status, 201);
    const repeated = await call('/api/sizes', { method: 'POST', token: 'admin-token', body: { ...body, name: 'm', garment: 'SACO' } });
    assert.equal(repeated.status, 409);
    assert.equal((await repeated.json()).code, 'SIZE_DUPLICATE');
  });

  test('duplicado: 409 SIZE_DUPLICATE', async () => {
    state.duplicate = true;
    const response = await call('/api/sizes', {
      method: 'POST', token: 'admin-token', body: { name: 'M', type: 'indumentaria' },
    });
    state.duplicate = false;
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'SIZE_DUPLICATE');
  });

  test('medidas maliciosas: 400 VALIDATION_ERROR con details y sin tocar la base', async () => {
    const queriesBefore = talleQueries().length;
    const response = await fetch(`${app.baseUrl}/api/sizes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer admin-token' },
      body: '{"name":"M","type":"calzado","measurements":{"__proto__":"x"}}',
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.ok(Array.isArray(body.details));
    assert.equal(talleQueries().length, queriesBefore);
  });
});

describe('PUT /api/sizes/:id', () => {
  test('desactiva un talle', async () => {
    const response = await call(`/api/sizes/${SIZE_ID}`, { method: 'PUT', token: 'admin-token', body: { active: false } });
    assert.equal(response.status, 200);
    const update = pool.queries.filter((query) => query.sql.startsWith('UPDATE public.talles')).pop();
    assert.deepEqual(update.params, [false, SIZE_ID]);
  });

  test('garment null borra la prenda; texto se recorta', async () => {
    const lastUpdate = () => pool.queries.filter((query) => query.sql.startsWith('UPDATE public.talles')).pop();
    await call(`/api/sizes/${SIZE_ID}`, { method: 'PUT', token: 'admin-token', body: { garment: null } });
    assert.match(lastUpdate().sql, /SET garment = \$1 /);
    assert.deepEqual(lastUpdate().params, [null, SIZE_ID]);
    await call(`/api/sizes/${SIZE_ID}`, { method: 'PUT', token: 'admin-token', body: { garment: ' Saco ' } });
    assert.deepEqual(lastUpdate().params, ['Saco', SIZE_ID]);
  });

  test('id inexistente: 404 SIZE_NOT_FOUND; id mal formado: 400 INVALID_SIZE_ID', async () => {
    const missing = await call(`/api/sizes/${UNKNOWN_ID}`, { method: 'PUT', token: 'admin-token', body: { active: true } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'SIZE_NOT_FOUND');
    const malformed = await call('/api/sizes/abc', { method: 'PUT', token: 'admin-token', body: { active: true } });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, 'INVALID_SIZE_ID');
  });

  test('body vacío: 400 NO_FIELDS; duplicado: 409', async () => {
    const empty = await call(`/api/sizes/${SIZE_ID}`, { method: 'PUT', token: 'admin-token', body: {} });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, 'NO_FIELDS');
    state.duplicate = true;
    const duplicate = await call(`/api/sizes/${SIZE_ID}`, { method: 'PUT', token: 'admin-token', body: { name: 'l' } });
    state.duplicate = false;
    assert.equal(duplicate.status, 409);
  });

  test('no existe DELETE: la ruta responde 404 y no toca la base', async () => {
    const queriesBefore = talleQueries().length;
    const response = await call(`/api/sizes/${SIZE_ID}`, { method: 'DELETE', token: 'admin-token' });
    assert.equal(response.status, 404);
    assert.equal(talleQueries().length, queriesBefore);
  });
});

describe('POST /api/products con optionMeta global', () => {
  const productWith = (sizeId) => ({
    name: 'Remera',
    price: 100,
    variants: [{ name: 'Talle', options: ['M'], optionMeta: { M: { source: 'global', sizeId } } }],
  });

  test('sizeId inexistente: 400 SIZE_NOT_FOUND y no se inserta el producto', async () => {
    const response = await call('/api/products', { method: 'POST', token: 'admin-token', body: productWith(UNKNOWN_ID) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'SIZE_NOT_FOUND');
    assert.equal(pool.queries.some((query) => query.sql.startsWith('INSERT INTO public.productos')), false);
  });

  test('sizeId existente: 201, una sola query de verificación y variants guardado con optionMeta', async () => {
    const lookups = () => pool.queries.filter((query) => query.sql.startsWith('SELECT id FROM public.talles')).length;
    const lookupsBefore = lookups();
    const response = await call('/api/products', { method: 'POST', token: 'admin-token', body: productWith(SIZE_ID) });
    assert.equal(response.status, 201);
    assert.equal(lookups() - lookupsBefore, 1);
    const insert = pool.queries.find((query) => query.sql.startsWith('INSERT INTO public.productos'));
    const saved = JSON.parse(insert.params[11]);
    assert.deepEqual(saved[0].optionMeta, { M: { source: 'global', sizeId: SIZE_ID } });
  });
});
