const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, installFakeSupabaseAuth, startApp } = require('./helpers/harness');

const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.test' };
const USER = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'user@example.test' };
const ROLES = { [ADMIN.id]: 'admin', [USER.id]: 'user' };
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const UNKNOWN_ID = '33333333-3333-4333-8333-333333333333';
const VENTA_ID = '22222222-2222-4222-8222-222222222222';
const BUYER_EMAIL = 'ana@example.test';
const ROW = {
  id: REQUEST_ID, code: 'ARR-2026-0001', name: 'Ana', email: BUYER_EMAIL, description: 'Campera', order_number: 1001,
  status: 'recibida', needs_review: false, admin_note: null, created_at: '2026-10-27T10:00:00Z',
  updated_at: '2026-10-27T10:00:00Z', resolved_at: null,
  purchases: [{ id: VENTA_ID, order_number: 1001, product_name: 'Campera', total_price: 100 }],
};

const pool = installFakeDatabase((sql, params) => {
  if (sql.startsWith('SELECT id, role, name FROM public.profiles')) {
    return { rows: [{ id: params[0], role: ROLES[params[0]] || 'user', name: 'Test' }] };
  }
  if (sql.includes('FROM public.ventas') && sql.includes('LOWER(buyer_email)')) {
    // Un pedido inexistente (9999) no coincide por filtros, pero el email sí tiene compras.
    return { rows: params[0] === BUYER_EMAIL && params[1] !== 9999 ? [{ id: VENTA_ID }] : [] };
  }
  if (sql.startsWith('INSERT INTO public.withdrawal_requests')) {
    return { rows: [{ code: 'ARR-2026-0001', created_at: '2026-10-27T10:00:00Z' }] };
  }
  if (sql.includes('FROM public.withdrawal_requests w')) return { rows: [{ ...ROW, total_count: 1 }] };
  if (sql.startsWith('UPDATE public.withdrawal_requests')) {
    return params[0] === REQUEST_ID ? { rows: [{ ...ROW, status: params[1] || ROW.status }] } : { rows: [] };
  }
  return undefined;
});
installFakeSupabaseAuth({ 'admin-token': ADMIN, 'user-token': USER });

let app;
before(async () => {
  app = await startApp([['/api/withdrawals', 'routes/withdrawalRoutes.js']]);
});
after(() => app.close());
beforeEach(() => { pool.queries.length = 0; });

const call = (path, { method = 'GET', token, body } = {}) => fetch(`${app.baseUrl}${path}`, {
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const queryStarting = (prefix) => pool.queries.find((query) => query.sql.startsWith(prefix));
const inserted = () => queryStarting('INSERT INTO public.withdrawal_requests');
const submit = (overrides = {}) => call('/api/withdrawals', {
  method: 'POST', body: { name: 'Ana', email: BUYER_EMAIL, description: 'Campera negra', orderNumber: 1001, ...overrides },
});

describe('POST /api/withdrawals (público)', () => {
  test('sin login: 201 con código de seguimiento y fecha de recepción', async () => {
    const response = await submit();
    const body = await response.json();
    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(body).sort(), ['code', 'receivedAt', 'success']);
    assert.match(body.code, /^ARR-\d{4}-\d{4}$/);
  });

  test('con compras del email: las vincula y no marca revisión', async () => {
    await submit();
    const { params } = inserted();
    assert.deepEqual(params[6], [VENTA_ID]);
    assert.equal(params[7], false);
  });

  test('sin compras del email: igual se guarda, marcada para revisión', async () => {
    const response = await submit({ email: 'nadie@example.test' });
    assert.equal(response.status, 201);
    const { params } = inserted();
    assert.deepEqual(params[6], []);
    assert.equal(params[7], true);
  });

  test('el email se guarda en minúsculas y el número de pedido viaja al cruce', async () => {
    await submit({ email: 'ANA@Example.test', orderNumber: '1001' });
    const match = pool.queries.find((query) => query.sql.includes('LOWER(buyer_email)'));
    assert.equal(match.params[0], BUYER_EMAIL);
    assert.equal(match.params[1], 1001);
    assert.equal(inserted().params[1], BUYER_EMAIL);
  });

  test('NEGATIVO: datos inválidos responden 400 con details y no tocan la base', async () => {
    const response = await submit({ email: 'sin-arroba', orderNumber: -3 });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.ok(body.details.some((detail) => detail.field === 'email'));
    assert.equal(pool.queries.length, 0);
  });

  test('NEGATIVO: no acepta status desde el cliente', async () => {
    assert.equal((await submit({ status: 'resuelta' })).status, 400);
  });
});

describe('GET /api/withdrawals (admin)', () => {
  test('sin token 401, usuario común 403', async () => {
    assert.equal((await call('/api/withdrawals')).status, 401);
    assert.equal((await call('/api/withdrawals', { token: 'user-token' })).status, 403);
  });

  test('admin: lista paginada con las compras vinculadas y sin cache', async () => {
    const response = await call('/api/withdrawals?status=recibida&limit=5', { token: 'admin-token' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('cache-control').includes('no-store'));
    assert.equal(body.total, 1);
    assert.equal(body.limit, 5);
    assert.equal(body.data[0].purchases[0].order_number, 1001);
    assert.equal('total_count' in body.data[0], false);
    const listQuery = pool.queries.find((query) => query.sql.includes('withdrawal_requests w'));
    assert.deepEqual(listQuery.params, ['recibida', 5, 0]);
  });

  test('NEGATIVO: un estado desconocido es 400', async () => {
    assert.equal((await call('/api/withdrawals?status=x', { token: 'admin-token' })).status, 400);
  });
});

describe('PATCH /api/withdrawals/:id (admin)', () => {
  const patch = (path, body, token = 'admin-token') => call(path, { method: 'PATCH', token, body });

  test('sin token 401, usuario común 403', async () => {
    assert.equal((await patch(`/api/withdrawals/${REQUEST_ID}`, { status: 'resuelta' }, null)).status, 401);
    assert.equal((await patch(`/api/withdrawals/${REQUEST_ID}`, { status: 'resuelta' }, 'user-token')).status, 403);
  });

  test('admin cambia el estado: 200 y el UPDATE fija resolved_at en la base', async () => {
    const response = await patch(`/api/withdrawals/${REQUEST_ID}`, { status: 'resuelta', adminNote: 'Devuelto' });
    assert.equal(response.status, 200);
    const update = queryStarting('UPDATE public.withdrawal_requests');
    assert.deepEqual(update.params, [REQUEST_ID, 'resuelta', true, 'Devuelto']);
    assert.match(update.sql, /resolved_at = CASE WHEN \$2 IN \('resuelta', 'rechazada'\) THEN now\(\)/);
  });

  test('solo la nota: no toca el estado', async () => {
    await patch(`/api/withdrawals/${REQUEST_ID}`, { adminNote: 'Llamar' });
    assert.deepEqual(queryStarting('UPDATE public.withdrawal_requests').params, [REQUEST_ID, null, true, 'Llamar']);
  });

  test('NEGATIVO: id inválido 400, cuerpo vacío 400, inexistente 404', async () => {
    assert.equal((await patch('/api/withdrawals/abc', { status: 'resuelta' })).status, 400);
    assert.equal((await patch(`/api/withdrawals/${REQUEST_ID}`, {})).status, 400);
    assert.equal((await patch(`/api/withdrawals/${UNKNOWN_ID}`, { status: 'resuelta' })).status, 404);
  });
});

test('un error de base responde 500 genérico sin detalles internos', async () => {
  const original = pool.query;
  pool.query = async () => { throw Object.assign(new Error('boom: secreto interno'), { code: 'XX000' }); };
  try {
    const response = await submit();
    const text = await response.text();
    assert.equal(response.status, 500);
    assert.equal(text.includes('secreto'), false);
  } finally {
    pool.query = original;
  }
});
