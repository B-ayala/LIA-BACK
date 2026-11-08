/**
 * H-03 (idempotencia respaldada por la base) y S-01 (tope de reservas bajo concurrencia).
 * Base en memoria con rollback, locks y el índice único real de `ventas` (ver helpers/fakeCheckoutDb.js).
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule, createRes, abs } = require('./helpers/harness');
const { createFakeCheckoutDb } = require('./helpers/fakeCheckoutDb');

process.env.MP_ACCESS_TOKEN = 'APP_USR-test-token';

let db;
const poolProxy = {
  query: (...args) => db.pool.query(...args),
  connect: (...args) => db.pool.connect(...args),
  on: () => undefined,
  options: { max: 20 },
  totalCount: 0,
  idleCount: 0,
  waitingCount: 0,
};
stubModule('config/database.js', {
  pool: poolProxy, connectDB: async () => poolProxy, isDBConnected: () => true, getPoolStats: () => ({}), closeDB: async () => undefined,
});

const User = require(abs('models/User.js'));
User.getPurchasePermission = async () => ({ allowed: true });
const { createTransferOrder, createMpPreference } = require(abs('controllers/orderController.js'));
const { reserveOrders } = require(abs('services/checkoutReservation.js'));
const mercadopago = require(abs('utils/mercadopago.js'));
const { caches } = require(abs('utils/cache.js'));

const USER = { id: '22222222-2222-4222-8222-222222222222', email: 'buyer@example.test', role: 'user' };
const OTHER = { id: '33333333-3333-4333-8333-333333333333', email: 'other@example.test', role: 'user' };
const KEY = 'clave-de-intento-0001';
const FINGERPRINT = 'abcdef012345';

const bodyFor = (quantity = 1, extra = {}) => ({
  buyerName: 'Cliente Prueba',
  buyerEmail: USER.email,
  shippingMethod: 'local',
  shippingCost: 0,
  totalPrice: 1000 * quantity,
  items: [{ productId: '7', productName: 'Remera', productImage: 'x', quantity, unitPrice: 1000, totalPrice: 1000 * quantity, unitsConfig: [] }],
  ...extra,
});

const place = async (handler, body, { user = USER, key = null } = {}) => {
  const res = createRes();
  await handler({ body, user, ip: '127.0.0.1', get: (name) => (name.toLowerCase() === 'idempotency-key' ? (key ?? undefined) : undefined) }, res);
  return res;
};

const line = (quantity = 1) => ({ productId: '7', productName: 'Remera', quantity, unitPrice: 1000, totalPrice: 1000 * quantity, unitsConfig: [] });

const reserveDirect = (userId, key, quantity = 1) => reserveOrders({
  buyerName: 'Cliente Prueba',
  buyerEmail: USER.email,
  userId,
  items: [line(quantity)],
  shippingMethod: 'local',
  paymentMethod: 'transfer',
  expectedTotal: 1000 * quantity,
  idempotency: key ? { key, fingerprint: FINGERPRINT } : null,
});

const pendingUnits = () => db.state.ventas
  .filter((v) => v.payment_status === 'pendiente')
  .reduce((sum, v) => sum + v.quantity, 0);

beforeEach(() => {
  db = createFakeCheckoutDb({ stock: 1000 });
  caches.idempotency.clear();
});

describe('H-03: la base es la fuente de verdad de la idempotencia', () => {
  test('cada línea guarda <key>:<huella>:<índice> en ventas.idempotency_key', async () => {
    const res = await place(createTransferOrder, bodyFor(1), { key: KEY });
    assert.equal(res.statusCode, 201);
    assert.match(db.state.ventas[0].idempotency_key, new RegExp(`^${KEY}:[0-9a-f]{12}:0$`));
  });

  test('sin header no se escribe key (comportamiento previo)', async () => {
    await place(createTransferOrder, bodyFor(1));
    assert.equal(db.state.ventas[0].idempotency_key, null);
  });

  test('POSITIVO: con la memoria vacía (reinicio) el reintento reenvía la MISMA orden desde la base, sin descontar de nuevo', async () => {
    const first = await place(createTransferOrder, bodyFor(2), { key: KEY });
    const stockAfterFirst = db.state.product.stock;
    caches.idempotency.clear();
    const retry = await place(createTransferOrder, bodyFor(2), { key: KEY });
    assert.equal(retry.statusCode, 201);
    assert.deepEqual(retry.body, first.body);
    assert.equal(db.state.ventas.length, 1);
    assert.equal(db.state.product.stock, stockAfterFirst);
  });

  test('NEGATIVO: la misma key con otro carrito responde 422 aunque no haya nada en memoria', async () => {
    await place(createTransferOrder, bodyFor(1), { key: KEY });
    caches.idempotency.clear();
    const reused = await place(createTransferOrder, bodyFor(2), { key: KEY });
    assert.equal(reused.statusCode, 422);
    assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(db.state.ventas.length, 1);
  });

  test('NEGATIVO: la misma key con otro medio de pago no cruza intentos', async () => {
    mercadopago.createPreference = async () => ({ id: 'pref-1', init_point: 'https://mp.test/pay' });
    await place(createTransferOrder, bodyFor(1), { key: KEY });
    caches.idempotency.clear();
    const res = await place(createMpPreference, bodyFor(1), { key: KEY });
    assert.equal(res.statusCode, 422);
    assert.equal(db.state.ventas.length, 1);
  });

  test('NEGATIVO: tras cancelar la orden, el reintento NO devuelve la respuesta vieja: crea un intento nuevo', async () => {
    const first = await place(createTransferOrder, bodyFor(1), { key: KEY });
    const [old] = db.state.ventas;
    old.payment_status = 'cancelado';
    db.state.product.stock += old.quantity;
    const retry = await place(createTransferOrder, bodyFor(1), { key: KEY });
    assert.equal(retry.statusCode, 201);
    assert.notDeepEqual(retry.body.order_ids, first.body.order_ids);
    assert.equal(old.idempotency_key, null, 'la key del intento muerto se libera');
    assert.equal(db.state.ventas.filter((v) => v.payment_status === 'pendiente').length, 1);
    assert.equal(db.state.product.stock, 999);
  });

  test('NEGATIVO: una orden vencida (expirado) tampoco se reenvía desde la base', async () => {
    await place(createTransferOrder, bodyFor(1), { key: KEY });
    db.state.ventas[0].payment_status = 'expirado';
    caches.idempotency.clear();
    const retry = await place(createTransferOrder, bodyFor(1), { key: KEY });
    assert.equal(retry.statusCode, 201);
    assert.equal(db.state.ventas.length, 2);
  });

  test('NEGATIVO: si la orden ya se pagó, el reintento responde 409 y no crea otra', async () => {
    await place(createTransferOrder, bodyFor(1), { key: KEY });
    db.state.ventas[0].payment_status = 'pagado';
    const retry = await place(createTransferOrder, bodyFor(1), { key: KEY });
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.body.code, 'CHECKOUT_ATTEMPT_CLOSED');
    assert.equal(db.state.ventas.length, 1);
  });

  test('MP: un reintento sin respuesta recordada responde 409 CHECKOUT_IN_PROGRESS, sin reservar otra vez', async () => {
    mercadopago.createPreference = async () => ({ id: 'pref-1', init_point: 'https://mp.test/pay' });
    const first = await place(createMpPreference, bodyFor(1), { key: KEY });
    assert.equal(first.statusCode, 201);
    caches.idempotency.clear();
    const retry = await place(createMpPreference, bodyFor(1), { key: KEY });
    assert.equal(retry.statusCode, 409);
    assert.equal(retry.body.code, 'CHECKOUT_IN_PROGRESS');
    assert.equal(db.state.ventas.length, 1);
  });

  test('MP: si Mercado Pago falla se libera la key y el reintento con la misma key vuelve a ejecutarse', async () => {
    mercadopago.createPreference = async () => { throw new Error('MP caído'); };
    const failed = await place(createMpPreference, bodyFor(1), { key: KEY });
    assert.equal(failed.statusCode, 502);
    assert.equal(db.state.product.stock, 1000, 'la compensación devolvió el stock');
    mercadopago.createPreference = async () => ({ id: 'pref-2', init_point: 'https://mp.test/pay2' });
    const retry = await place(createMpPreference, bodyFor(1), { key: KEY });
    assert.equal(retry.statusCode, 201);
    assert.equal(retry.body.init_point, 'https://mp.test/pay2');
  });

  test('CARRERA: dos requests con la misma key a la vez (sin single-flight) crean UN solo intento', async () => {
    const results = await Promise.all([reserveDirect(USER.id, KEY, 2), reserveDirect(USER.id, KEY, 2)]);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    assert.equal(results.filter((r) => r.replayed).length, 1);
    assert.deepEqual(results[0].orderIds, results[1].orderIds);
    assert.equal(db.state.ventas.length, 1);
    assert.equal(db.state.product.stock, 998);
  });

  test('CARRERA: la misma key en usuarios distintos son intentos independientes', async () => {
    const results = await Promise.all([reserveDirect(USER.id, KEY), reserveDirect(OTHER.id, KEY)]);
    assert.ok(results.every((r) => r.ok && !r.replayed));
    assert.equal(db.state.ventas.length, 2);
  });

  test('RESPALDO 23505: si el índice único salta a mitad de la reserva, el rollback devuelve el stock y no deja huérfanas', async () => {
    // Una venta del mismo intento ya ocupa la key de la segunda línea y la lectura previa no la ve.
    db.state.ventas.push({
      id: 'order-prev', user_id: USER.id, product_id: '7', quantity: 1, payment_status: 'pendiente',
      idempotency_key: `${KEY}:${FINGERPRINT}:1`, order_number: 5, mp_external_reference: null,
    });
    db.state.hideIdempotencyLookups = 1;
    const result = await reserveOrders({
      buyerName: 'Cliente Prueba', buyerEmail: USER.email, userId: USER.id, shippingMethod: 'local', paymentMethod: 'transfer',
      items: [line(1), line(1)],
      expectedTotal: 2000,
      idempotency: { key: KEY, fingerprint: FINGERPRINT },
    });
    assert.equal(db.state.product.stock, 1000, 'el descuento de la línea 0 se deshizo con el rollback');
    assert.equal(db.state.ventas.length, 1, 'no quedó la venta de la línea 0');
    assert.equal(result.replayed, true, JSON.stringify(result));
    assert.deepEqual(result.orderIds, ['order-prev']);
  });
});

describe('S-01: el tope de reservas por usuario resiste requests paralelas', () => {
  test('el lock por usuario se toma ANTES de leer el contador de pendientes', async () => {
    await reserveDirect(USER.id, null);
    const sqls = db.state.queries.map((q) => q.sql);
    const lockAt = sqls.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
    const countAt = sqls.findIndex((sql) => sql.includes('COUNT(*)'));
    assert.ok(lockAt >= 0 && lockAt < countAt, `lock en ${lockAt}, conteo en ${countAt}`);
    const lock = db.state.queries[lockAt];
    assert.deepEqual([lock.params[0], lock.params[1]], [7301, USER.id]);
  });

  test('6 reservas de 20 unidades en paralelo: no se pasa de 60 unidades pendientes', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => reserveDirect(USER.id, null, 20)));
    assert.equal(results.filter((r) => r.ok).length, 3);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.status === 429 && r.code === 'TOO_MANY_PENDING_ORDERS'));
    assert.ok(pendingUnits() <= 60, `pendientes: ${pendingUnits()}`);
    assert.equal(db.state.product.stock, 1000 - pendingUnits());
  });

  test('40 reservas de 1 unidad en paralelo: no se pasa de 30 líneas pendientes', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => reserveDirect(USER.id, null, 1)));
    assert.equal(results.filter((r) => r.ok).length, 30);
    assert.equal(db.state.ventas.length, 30);
  });

  test('el tope es por usuario: otro usuario no queda bloqueado por el primero', async () => {
    await Promise.all(Array.from({ length: 4 }, () => reserveDirect(USER.id, null, 20)));
    const other = await reserveDirect(OTHER.id, null, 20);
    assert.equal(other.ok, true);
  });
});
