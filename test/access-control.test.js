const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, installFakeSupabaseAuth, startApp } = require('./helpers/harness');

const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'admin@example.test' };
const USER = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'user@example.test' };
const OTHER = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'other@example.test' };
const ROLES = { [ADMIN.id]: 'admin', [USER.id]: 'user', [OTHER.id]: 'user' };
const FOREIGN_ORDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const pool = installFakeDatabase((sql, params) => {
  if (sql.startsWith('SELECT id, role, name FROM public.profiles')) {
    const role = ROLES[params[0]];
    return role ? { rows: [{ id: params[0], role, name: 'Test' }] } : { rows: [] };
  }
  if (sql.includes('COUNT(*) as count')) return { rows: [{ count: '0' }] };
  if (sql.includes('FROM public.ventas WHERE id = $1::uuid FOR UPDATE')) {
    // Orden de OTRO usuario, de Mercado Pago y todavía pendiente.
    return { rows: [{ id: FOREIGN_ORDER, user_id: OTHER.id, buyer_email: OTHER.email, payment_method: 'mp', payment_status: 'pendiente', product_id: 1, quantity: 1 }] };
  }
  if (sql.includes('SELECT is_owner')) return { rows: [{ is_owner: false }] };
  if (sql.includes('UPDATE public.profiles')) return { rows: [{ id: params[params.length - 1], name: 'x', role: 'user' }] };
  if (sql.includes('FROM public.ventas') && sql.includes('LOWER(buyer_email)')) return { rows: [] };
  return undefined;
});

installFakeSupabaseAuth({
  'admin-token': { id: ADMIN.id, email: ADMIN.email },
  'user-token': { id: USER.id, email: USER.email },
});

let app;
before(async () => {
  app = await startApp([
    ['/api/products', 'routes/productRoutes.js'],
    ['/api/users', 'routes/userRoutes.js'],
    ['/api/orders', 'routes/orderRoutes.js'],
    ['/api/cloudinary', 'routes/cloudinaryRoutes.js'],
    ['/api/admin/insights', 'routes/insightsRoutes.js'],
  ]);
});
after(() => app.close());

const call = async (method, path, { token, body } = {}) => {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const ADMIN_ONLY = [
  ['POST', '/api/products', { name: 'x', price: 10 }],
  ['PUT', '/api/products/1', { name: 'x' }],
  ['DELETE', '/api/products/1'],
  ['GET', '/api/users'],
  ['GET', `/api/users/${USER.id}`],
  ['GET', `/api/users/auth/${USER.id}`],
  ['PUT', `/api/users/${USER.id}`, { role: 'admin' }],
  ['DELETE', `/api/users/${OTHER.id}`],
  ['PATCH', `/api/orders/${FOREIGN_ORDER}/confirm-transfer`],
  ['PATCH', `/api/orders/${FOREIGN_ORDER}/cancel-transfer`],
  ['GET', '/api/admin/insights/low-stock'],
  ['GET', '/api/admin/insights/top-products'],
  ['POST', '/api/cloudinary/sign', { folder: 'x', timestamp: 1 }],
  ['POST', '/api/cloudinary/delete', { publicId: 'x' }],
  ['GET', '/api/cloudinary/images'],
  ['DELETE', '/api/cloudinary/folders', { path: 'x' }],
];

describe('Un cliente no ejecuta operaciones admin (prueba 2)', () => {
  for (const [method, path, body] of ADMIN_ONLY) {
    test(`NEGATIVO: ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} sin token -> 401`, async () => {
      assert.equal((await call(method, path, { body })).status, 401);
    });
    test(`NEGATIVO: ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')} con token de usuario común -> 403`, async () => {
      assert.equal((await call(method, path, { token: 'user-token', body })).status, 403);
    });
  }

  test('NEGATIVO: un token inválido o revocado se trata como no autenticado', async () => {
    assert.equal((await call('GET', '/api/users', { token: 'token-revocado' })).status, 401);
  });

  test('NEGATIVO: el rol enviado por el navegador (header/body) no otorga permisos', async () => {
    const response = await fetch(`${app.baseUrl}/api/users`, {
      headers: { Authorization: 'Bearer user-token', 'X-User-Role': 'admin', 'X-Role': 'admin' },
    });
    assert.equal(response.status, 403);
  });

  test('POSITIVO: el admin sí llega al controlador', async () => {
    const list = await call('GET', '/api/users', { token: 'admin-token' });
    assert.equal(list.status, 200);
    const missing = await call('PATCH', `/api/orders/${FOREIGN_ORDER}/confirm-transfer`, { token: 'admin-token' });
    assert.notEqual(missing.status, 401);
    assert.notEqual(missing.status, 403);
  });
});

describe('IDOR / BOLA sobre pedidos (prueba 1)', () => {
  test('NEGATIVO: consultar las compras de otro email -> 403', async () => {
    const { status } = await call('GET', `/api/orders/user?email=${OTHER.email}`, { token: 'user-token' });
    assert.equal(status, 403);
  });

  test('NEGATIVO: el email se compara sin distinguir mayúsculas pero no admite variantes de otro usuario', async () => {
    const { status } = await call('GET', `/api/orders/user?email=${encodeURIComponent(`${USER.email}.evil`)}`, { token: 'user-token' });
    assert.equal(status, 403);
  });

  test('POSITIVO: consultar las compras propias -> 200', async () => {
    const { status, body } = await call('GET', `/api/orders/user?email=${USER.email.toUpperCase()}`, { token: 'user-token' });
    assert.equal(status, 200);
    assert.equal(body.success, true);
  });

  test('NEGATIVO: cancelar la orden de otro usuario -> 403 y sin UPDATE', async () => {
    pool.queries.length = 0;
    const { status } = await call('POST', `/api/orders/${FOREIGN_ORDER}/cancel`, { token: 'user-token' });
    assert.equal(status, 403);
    assert.equal(pool.queries.some((q) => q.sql.startsWith('UPDATE')), false);
  });

  test('NEGATIVO: el nudge sobre una orden ajena no la modifica', async () => {
    pool.queries.length = 0;
    const { status, body } = await call('POST', '/api/orders/nudge', {
      token: 'user-token',
      body: { orderIds: [FOREIGN_ORDER], response: 'abandonado' },
    });
    assert.equal(status, 200);
    assert.equal(body.applied, 0);
    assert.equal(pool.queries.some((q) => q.sql.startsWith('UPDATE')), false);
  });

  test('POSITIVO: el admin puede cancelar una orden de MP ajena (flujo de soporte)', async () => {
    const { status } = await call('POST', `/api/orders/${FOREIGN_ORDER}/cancel`, { token: 'admin-token' });
    assert.equal(status, 200);
  });
});

describe('Mass assignment (prueba B)', () => {
  test('NEGATIVO: PUT /users/:id solo escribe name/role/purchase_allowed_exclusive', async () => {
    pool.queries.length = 0;
    await call('PUT', `/api/users/${USER.id}`, {
      token: 'admin-token',
      body: { role: 'user', is_owner: true, email: 'otro@example.test', id: OTHER.id, password_hash: 'x' },
    });
    const update = pool.queries.find((q) => q.sql.includes('UPDATE public.profiles'));
    assert.ok(update, 'debe ejecutar el UPDATE de perfil');
    assert.doesNotMatch(update.sql, /is_owner\s*=|email\s*=|password_hash\s*=|SET\s+id\s*=/);
    assert.equal(update.params.includes('otro@example.test'), false);
  });

  test('NEGATIVO: rol fuera de la lista blanca se rechaza', async () => {
    const { status } = await call('PUT', `/api/users/${USER.id}`, { token: 'admin-token', body: { role: 'superadmin' } });
    assert.equal(status, 400);
  });
});

describe('Validación de entradas en rutas públicas', () => {
  test('NEGATIVO: id de producto con inyección SQL responde 404 y no consulta la base', async () => {
    pool.queries.length = 0;
    const { status } = await call('GET', `/api/products/${encodeURIComponent("1 OR 1=1; DROP TABLE productos--")}`);
    assert.equal(status, 404);
    assert.equal(pool.queries.length, 0);
  });

  test('NEGATIVO: crear producto con precio negativo (admin) responde 400', async () => {
    const { status } = await call('POST', '/api/products', { token: 'admin-token', body: { name: 'x', price: -5 } });
    assert.equal(status, 400);
  });

  test('NEGATIVO: crear producto con campo de estado inventado responde 400', async () => {
    const { status } = await call('POST', '/api/products', { token: 'admin-token', body: { name: 'x', price: 5, status: 'hacked' } });
    assert.equal(status, 400);
  });

  test('NEGATIVO: body JSON mayor a 256kb responde error de cliente', async () => {
    pool.queries.length = 0;
    const response = await fetch(`${app.baseUrl}/api/orders/nudge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer user-token' },
      body: JSON.stringify({ orderIds: ['x'], response: 'confirmado', pad: 'A'.repeat(300 * 1024) }),
    });
    assert.notEqual(response.status, 200);
    assert.equal(pool.queries.some((q) => q.sql.includes('public.ventas')), false);
  });
});
