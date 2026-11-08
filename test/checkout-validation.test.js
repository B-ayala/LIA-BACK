/**
 * S-03: validación estricta del body del checkout en el borde (Zod strict), antes de tomar
 * cualquier lock de producto, con el formato de error { success:false, code, message, details }.
 * El método de envío "moto" ya no existe: se rechaza como cualquier valor desconocido.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, createRes, abs } = require('./helpers/harness');

process.env.MP_ACCESS_TOKEN = 'APP_USR-test-token';

const pool = installFakeDatabase((sql, params) => {
  if (sql.includes('FROM public.productos') && sql.includes('FOR UPDATE')) {
    return { rows: [{ stock: 50, price: 1000, name: 'Remera', status: 'active', variants: null }] };
  }
  if (sql.includes("payment_status = 'pendiente'") && sql.includes('COUNT(*)')) return { rows: [{ pending: 0, units: 0 }] };
  if (sql.includes('ventas_order_number_seq')) return { rows: [{ order_number: 1 }] };
  if (sql.startsWith('INSERT INTO public.ventas')) return { rows: [{ id: `order-${params[3]}` }] };
  return undefined;
});

const User = require(abs('models/User.js'));
User.getPurchasePermission = async () => ({ allowed: true });
const { createTransferOrder } = require(abs('controllers/orderController.js'));

const USER = { id: '22222222-2222-4222-8222-222222222222', email: 'buyer@example.test', role: 'user' };

const validItem = () => ({
  productId: '7', productName: 'Remera', productImage: 'x', quantity: 1, unitPrice: 1000, totalPrice: 1000, unitsConfig: [],
});

let counter = 0;
const validBody = (overrides = {}) => {
  counter += 1;
  return {
    buyerName: `Cliente ${counter}`, buyerEmail: USER.email, shippingMethod: 'local', shippingCost: 0, totalPrice: 1000,
    items: [validItem()], ...overrides,
  };
};

const post = async (body) => {
  const res = createRes();
  await createTransferOrder({ body, user: USER, ip: '127.0.0.1', get: () => undefined }, res);
  return res;
};

const assertRejectedAtTheEdge = (res, code = 'VALIDATION_ERROR') => {
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.equal(res.body.code, code);
  assert.equal(typeof res.body.message, 'string');
  assert.ok(res.body.message.length > 0);
  assert.ok(pool.queries.every((q) => !q.sql.includes('FOR UPDATE')), 'no se tomó ningún lock de producto');
  assert.ok(pool.queries.every((q) => !q.sql.startsWith('BEGIN')), 'ni siquiera se abrió una transacción');
};

beforeEach(() => { pool.queries.length = 0; });

describe('S-03: método de envío (whitelist estricta)', () => {
  for (const method of ['moto', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'drone', '', 'LOCAL']) {
    test(`NEGATIVO: shippingMethod ${JSON.stringify(method)} responde 400 INVALID_SHIPPING sin lock`, async () => {
      const res = await post(validBody({ shippingMethod: method }));
      assertRejectedAtTheEdge(res, 'INVALID_SHIPPING');
    });
  }

  test('NEGATIVO: shippingMethod ausente se rechaza', async () => {
    const body = validBody();
    delete body.shippingMethod;
    assertRejectedAtTheEdge(await post(body), 'INVALID_SHIPPING');
  });

  for (const method of [['local'], { a: 1 }, 5, true]) {
    test(`NEGATIVO: shippingMethod de tipo ${typeof method}${Array.isArray(method) ? ' (array)' : ''} responde 400 VALIDATION_ERROR`, async () => {
      assertRejectedAtTheEdge(await post(validBody({ shippingMethod: method })));
    });
  }

  test('POSITIVO: local y correo siguen aceptados', async () => {
    assert.equal((await post(validBody({ shippingMethod: 'local' }))).statusCode, 201);
    assert.equal((await post(validBody({ shippingMethod: 'correo', totalPrice: 5400 }))).statusCode, 201);
  });
});

describe('S-03: tipos y formas del body', () => {
  const cases = {
    'buyerName objeto': { buyerName: { $ne: null } },
    'buyerName número': { buyerName: 123 },
    'buyerName vacío': { buyerName: '   ' },
    'buyerEmail array': { buyerEmail: ['a@b.com'] },
    'buyerEmail inválido': { buyerEmail: 'no-es-email' },
    'items string': { items: 'x' },
    'items objeto': { items: { 0: {} } },
    'items vacío': { items: [] },
    'items con null': { items: [null] },
    'items con más de 50 líneas': { items: Array.from({ length: 51 }, validItem) },
    'totalPrice string': { totalPrice: '1000' },
    'totalPrice negativo': { totalPrice: -5 },
    'totalPrice Infinity (1e999)': { totalPrice: 1e999 },
    'totalPrice cero': { totalPrice: 0 },
    'shippingCost string': { shippingCost: '0' },
    'clave desconocida': { isAdmin: true },
    'clave __proto__': JSON.parse('{"__proto__": {"admin": true}}'),
  };
  for (const [name, patch] of Object.entries(cases)) {
    test(`NEGATIVO: ${name} responde 400 con details y sin tocar la base`, async () => {
      const res = await post(validBody(patch));
      assertRejectedAtTheEdge(res);
      assert.ok(Array.isArray(res.body.details) && res.body.details.length > 0);
      assert.ok(res.body.details.every((d) => typeof d.field === 'string' && typeof d.message === 'string'));
    });
  }

  const itemCases = {
    'productName objeto': { productName: { a: 1 } },
    'productName vacío': { productName: ' ' },
    'quantity decimal': { quantity: 1.5 },
    'quantity string': { quantity: '1' },
    'quantity cero': { quantity: 0 },
    'quantity negativa': { quantity: -1 },
    'quantity sobre el tope por línea': { quantity: 21 },
    'unitPrice string': { unitPrice: '1000' },
    'unitPrice negativo': { unitPrice: -1 },
    'totalPrice 1e999': { totalPrice: 1e999 },
    'productId objeto': { productId: { $gt: '' } },
    'productId array': { productId: [7] },
    'productImage objeto': { productImage: { a: 1 } },
    'unitsConfig objeto': { unitsConfig: { Talle: 'M' } },
    'unitsConfig con más de 100 unidades': { unitsConfig: Array.from({ length: 101 }, () => ({})) },
    'unitsConfig con valores anidados': { unitsConfig: [{ Talle: { $gt: '' } }] },
    'unitsConfig con valor gigante': { unitsConfig: [{ Talle: 'M'.repeat(5000) }] },
    'clave desconocida en el ítem': { price: 1 },
  };
  for (const [name, patch] of Object.entries(itemCases)) {
    test(`NEGATIVO: ítem con ${name} responde 400 antes de cualquier lock`, async () => {
      assertRejectedAtTheEdge(await post(validBody({ items: [{ ...validItem(), ...patch }] })));
    });
  }

  test('NEGATIVO: un body que no es objeto (null, array, string) responde 400', async () => {
    for (const body of [null, undefined, [], 'x', 5]) {
      pool.queries.length = 0;
      assertRejectedAtTheEdge(await post(body));
    }
  });

  test('POSITIVO: productId numérico, imagen nula y unitsConfig ausente se aceptan (contrato del frontend)', async () => {
    const item = { ...validItem(), productId: 7, productImage: null };
    delete item.unitsConfig;
    assert.equal((await post(validBody({ items: [item] }))).statusCode, 201);
  });

  test('el mensaje del primer problema llega al usuario en español y no enumera claves ajenas', async () => {
    const res = await post(validBody({ isAdmin: true }));
    assert.equal(res.body.message, 'Los datos de la compra no son válidos.');
    assert.ok(!JSON.stringify(res.body).includes('isAdmin'));
  });
});
