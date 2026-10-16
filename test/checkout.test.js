const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, createRes, abs } = require('./helpers/harness');

process.env.MP_ACCESS_TOKEN = 'APP_USR-test-token';

let product;
let pendingLines;
const pool = installFakeDatabase((sql, params) => {
  if (sql.includes('FROM public.productos') && sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1')) {
    return { rows: product ? [product] : [] };
  }
  if (sql.includes("payment_status = 'pendiente'") && sql.includes('COUNT(*)')) {
    return { rows: [{ pending: pendingLines }] };
  }
  if (sql.startsWith('INSERT INTO public.ventas')) return { rows: [{ id: `order-${params[3]}` }] };
  return undefined;
});

const User = require(abs('models/User.js'));
const { createTransferOrder } = require(abs('controllers/orderController.js'));

User.getPurchasePermission = async () => ({ allowed: true });

const USER = { id: '22222222-2222-4222-8222-222222222222', email: 'buyer@example.test', role: 'user' };

const validBody = (overrides = {}) => ({
  buyerName: 'Cliente Prueba',
  buyerEmail: 'buyer@example.test',
  shippingMethod: 'local',
  shippingCost: 0,
  totalPrice: 1,
  items: [{
    productId: 7, productName: 'Remera', productImage: 'x', quantity: 1, unitPrice: 1, totalPrice: 1, unitsConfig: [],
    ...(overrides.item || {}),
  }],
  ...overrides.body,
});

let uniqueCart = 0;
// Cada llamada usa un carrito distinto: evita que el single-flight de checkout colapse requests de tests distintos.
const placeTransfer = async (body) => {
  uniqueCart += 1;
  const res = createRes();
  await createTransferOrder({ body: { ...body, buyerName: `${body.buyerName} ${uniqueCart}` }, user: USER, get: () => undefined }, res);
  return res;
};

const insertedRow = () => pool.queries.find((q) => q.sql.startsWith('INSERT INTO public.ventas'));

beforeEach(() => {
  pool.queries.length = 0;
  pendingLines = 0;
  product = { stock: 5, price: 10000, discount: null, original_price: null, name: 'Remera Lisa', image_url: 'db.jpg', status: 'active' };
});

describe('El servidor decide el importe (prueba 4)', () => {
  test('NEGATIVO: el unitPrice/totalPrice del navegador se ignoran: se cobra el precio de la base', async () => {
    const res = await placeTransfer(validBody({ item: { unitPrice: 1, totalPrice: 1 }, body: { totalPrice: 1 } }));
    assert.equal(res.statusCode, 201);
    const { params } = insertedRow();
    assert.equal(params[7], 10000, 'unit_price sale de la base');
    assert.equal(params[8], 10000, 'total_price sale de la base');
    assert.equal(params[4], 'Remera Lisa', 'el nombre sale de la base');
  });

  test('NEGATIVO: el descuento se aplica en el servidor aunque el cliente no lo mande', async () => {
    product.discount = 20;
    const res = await placeTransfer(validBody());
    assert.equal(res.statusCode, 201);
    assert.equal(insertedRow().params[7], 8000);
  });

  test('NEGATIVO: el costo de envío de correo lo fija el servidor, no el body', async () => {
    const res = await placeTransfer(validBody({ body: { shippingMethod: 'correo', shippingCost: 0 } }));
    assert.equal(res.statusCode, 201);
    assert.equal(insertedRow().params[8], 10000 + 4400);
  });

  test('POSITIVO: la compra legítima registra una venta pendiente con los datos de la base', async () => {
    const res = await placeTransfer(validBody({ item: { unitPrice: 10000, totalPrice: 10000 } }));
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.order_ids.length, 1);
  });
});

describe('Stock y disponibilidad (pruebas 8 y 9, parte lógica)', () => {
  test('NEGATIVO: cantidad mayor al stock responde 409 y no inserta', async () => {
    const res = await placeTransfer(validBody({ item: { quantity: 6 } }));
    assert.equal(res.statusCode, 409);
    assert.equal(insertedRow(), undefined);
  });

  test('NEGATIVO: un producto inactivo no se puede comprar por id directo', async () => {
    product.status = 'inactive';
    const res = await placeTransfer(validBody());
    assert.equal(res.statusCode, 409);
    assert.equal(insertedRow(), undefined);
  });

  test('POSITIVO: un producto con status nulo se trata como activo (igual que el catálogo)', async () => {
    product.status = null;
    const res = await placeTransfer(validBody());
    assert.equal(res.statusCode, 201);
  });

  test('NEGATIVO: producto inexistente responde 409', async () => {
    product = null;
    const res = await placeTransfer(validBody());
    assert.equal(res.statusCode, 409);
  });

  test('la reserva toma el lock de fila (FOR UPDATE) antes de validar stock', async () => {
    await placeTransfer(validBody());
    const order = pool.queries.map((q) => q.sql);
    const lockIndex = order.findIndex((sql) => sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1'));
    const insertIndex = order.findIndex((sql) => sql.startsWith('INSERT INTO public.ventas'));
    assert.ok(lockIndex >= 0 && lockIndex < insertIndex);
  });
});

describe('Retención de stock por una sola cuenta (prueba 12/H)', () => {
  test('NEGATIVO: con demasiadas líneas pendientes se rechaza con 429 y no reserva', async () => {
    pendingLines = 30;
    const res = await placeTransfer(validBody());
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'TOO_MANY_PENDING_ORDERS');
    assert.equal(insertedRow(), undefined);
  });

  test('POSITIVO: justo en el límite todavía se puede comprar', async () => {
    pendingLines = 29;
    const res = await placeTransfer(validBody());
    assert.equal(res.statusCode, 201);
  });

  test('POSITIVO: el tope es configurable por entorno', async () => {
    process.env.MAX_PENDING_LINES_PER_USER = '2';
    pendingLines = 2;
    const res = await placeTransfer(validBody());
    delete process.env.MAX_PENDING_LINES_PER_USER;
    assert.equal(res.statusCode, 429);
  });
});

describe('Entradas maliciosas en la orden (prueba 10)', () => {
  test('NEGATIVO: unitsConfig con objetos anidados se rechaza', async () => {
    const res = await placeTransfer(validBody({ item: { unitsConfig: [{ Talle: { $gt: '' } }] } }));
    assert.equal(res.statusCode, 400);
    assert.equal(insertedRow(), undefined);
  });

  test('NEGATIVO: unitsConfig con más unidades que la cantidad se rechaza', async () => {
    const res = await placeTransfer(validBody({ item: { quantity: 1, unitsConfig: [{ Talle: 'M' }, { Talle: 'L' }] } }));
    assert.equal(res.statusCode, 400);
  });

  test('NEGATIVO: unitsConfig que no es una lista se rechaza', async () => {
    const res = await placeTransfer(validBody({ item: { unitsConfig: '<img src=x onerror=alert(1)>' } }));
    assert.equal(res.statusCode, 400);
  });

  test('NEGATIVO: valor de variante gigante se rechaza', async () => {
    const res = await placeTransfer(validBody({ item: { unitsConfig: [{ Talle: 'M'.repeat(5000) }] } }));
    assert.equal(res.statusCode, 400);
  });

  test('NEGATIVO: nombre de comprador desmedido se rechaza', async () => {
    const res = await placeTransfer(validBody({ body: { buyerName: 'A'.repeat(500) } }));
    assert.equal(res.statusCode, 400);
  });

  test('POSITIVO: variantes por unidad legítimas (talle y color) se guardan como JSON', async () => {
    const config = [{ Talle: 'M', Color: 'Negro' }];
    const res = await placeTransfer(validBody({ item: { unitsConfig: config } }));
    assert.equal(res.statusCode, 201);
    assert.equal(insertedRow().params[9], JSON.stringify(config));
  });

  test('NEGATIVO: un productId con inyección SQL no llega a la consulta como texto', async () => {
    const res = await placeTransfer(validBody({ item: { productId: "7; DROP TABLE ventas;--" } }));
    // parseInt('7; DROP...') = 7: la consulta siempre es parametrizada, nunca se concatena.
    assert.ok(pool.queries.every((q) => !q.sql.includes('DROP')));
    assert.ok([201, 400, 409].includes(res.statusCode));
  });
});

describe('Idempotencia y reintentos (prueba 7/E)', () => {
  test('NEGATIVO: Idempotency-Key con formato inválido responde 400', async () => {
    uniqueCart += 1;
    const res = createRes();
    await createTransferOrder(
      { body: validBody({ body: { buyerName: `Cliente ${uniqueCart}` } }), user: USER, get: () => 'corta' },
      res
    );
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'INVALID_IDEMPOTENCY_KEY');
  });
});
