/**
 * Pruebas contra un PostgreSQL REAL y aislado (locks, trigger de stock, SQL de los
 * modelos, auditoría). Se saltean salvo que se defina LIA_TEST_DB_PORT.
 *
 * Seguridad: solo corre contra 127.0.0.1 y una base llamada `lia_test`. Nunca lee el
 * `.env`: las credenciales DB_* se fijan acá, así que no puede tocar Supabase.
 * Cómo levantar la base local: ver TC-340 en `qa/test-plan.md`.
 *
 *   LIA_TEST_DB_PORT=54329 npm test
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.LIA_TEST_DB_PORT;
const enabled = Boolean(PORT);
const root = path.resolve(__dirname, '..', '..');

let pool;
let reserveOrders;
let Order;
let Product;
let withTransaction;
let settleApprovedPayment;

const createUser = async () => {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
  return id;
};

const createProduct = async ({ stock, variants = null, price = 1000 }) => {
  const { rows } = await pool.query(
    `INSERT INTO public.productos (name, price, stock, variants, status)
     VALUES ('Producto QA integración', $1, $2, $3, 'active') RETURNING id`,
    [price, stock, variants ? JSON.stringify(variants) : null]
  );
  return String(rows[0].id);
};

const readProduct = async (id) =>
  (await pool.query('SELECT stock, variants FROM public.productos WHERE id = $1', [id])).rows[0];

const countVentas = async (productId) =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM public.ventas WHERE product_id = $1', [productId])).rows[0].n;

const buy = (userId, productId, quantity = 1, extra = {}) => reserveOrders({
  buyerName: 'Cliente QA',
  buyerEmail: `${userId}@example.test`,
  userId,
  items: [{ productId, productName: 'x', quantity, unitPrice: 1, totalPrice: 1, unitsConfig: extra.unitsConfig || [] }],
  shippingMethod: 'local',
  shippingCost: 0,
  paymentMethod: extra.paymentMethod || 'transfer',
});

describe('PostgreSQL real: reserva, pago y auditoría', { skip: !enabled }, () => {
  before(async () => {
    if (!/^\d+$/.test(PORT)) throw new Error('LIA_TEST_DB_PORT inválido');
    Object.assign(process.env, {
      DB_HOST: '127.0.0.1', DB_PORT: PORT, DB_USER: 'postgres', DB_PASSWORD: '', DB_NAME: 'lia_test',
      LOG_LEVEL: 'error', DB_POOL_MAX: '20',
    });
    ({ pool } = require(path.join(root, 'config/database.js')));
    ({ reserveOrders } = require(path.join(root, 'services/checkoutReservation.js')));
    ({ withTransaction } = require(path.join(root, 'utils/transaction.js')));
    Order = require(path.join(root, 'models/Order.js'));
    Product = require(path.join(root, 'models/Product.js'));
    ({ settleApprovedPayment } = require(path.join(root, 'utils/paymentSettlement.js')));
    const { rows } = await pool.query('SELECT current_database() AS db');
    assert.equal(rows[0].db, 'lia_test', 'solo se corre contra la base de prueba');
    const proposed = fs.readFileSync(path.join(root, 'db/migrations/2026-10-16_audit_actor_PROPOSED.sql'), 'utf8');
    await pool.query(proposed);
  });

  after(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM public.ventas WHERE buyer_name = 'Cliente QA'");
  });

  test('NEGATIVO: 25 compradores simultáneos de la última unidad: gana uno solo y el stock queda en 0', async () => {
    const productId = await createProduct({ stock: 1 });
    const users = await Promise.all(Array.from({ length: 25 }, createUser));
    const results = await Promise.all(users.map((id) => buy(id, productId)));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.status === 409));
    assert.equal((await readProduct(productId)).stock, 0);
    assert.equal(await countVentas(productId), 1);
  });

  test('NEGATIVO: la última unidad de UN TALLE no se vende dos veces (stockByOption y total coherentes)', async () => {
    const variants = [{ name: 'Talle', options: ['M', 'L'], stockByOption: { M: 1, L: 5 } }];
    const productId = await createProduct({ stock: 6, variants });
    const users = await Promise.all(Array.from({ length: 12 }, createUser));
    const results = await Promise.all(users.map((id) => buy(id, productId, 1, { unitsConfig: [{ Talle: 'M' }] })));
    assert.equal(results.filter((r) => r.ok).length, 1);
    const product = await readProduct(productId);
    assert.equal(product.stock, 5);
    assert.equal(product.variants[0].stockByOption.M, 0);
    assert.equal(product.variants[0].stockByOption.L, 5);
  });

  test('POSITIVO: carritos con los mismos productos en distinto orden no se traban (sin deadlock)', async () => {
    const first = await createProduct({ stock: 50 });
    const second = await createProduct({ stock: 50 });
    const cart = (ids) => ids.map((productId) => ({ productId, productName: 'x', quantity: 1, unitPrice: 1, totalPrice: 1 }));
    const run = async (ids) => reserveOrders({
      buyerName: 'Cliente QA', buyerEmail: 'a@example.test', userId: await createUser(), items: cart(ids),
      shippingMethod: 'local', shippingCost: 0, paymentMethod: 'transfer',
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => run(index % 2 ? [first, second] : [second, first]))
    );
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.find((r) => !r.ok)));
  });

  test('NEGATIVO: una cuenta no retiene más de 60 unidades pendientes aunque use pocas líneas', async () => {
    const productId = await createProduct({ stock: 500 });
    const user = await createUser();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await buy(user, productId, 20)).ok, true);
    }
    const blocked = await buy(user, productId, 1);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 429);
    assert.equal((await readProduct(productId)).stock, 440);
  });

  describe('pagos', () => {
    const reserveMp = async (stock = 5, quantity = 2) => {
      const productId = await createProduct({ stock, price: 1000 });
      const reservation = await buy(await createUser(), productId, quantity, { paymentMethod: 'mp' });
      assert.equal(reservation.ok, true);
      return { productId, reservation, total: quantity * 1000 };
    };
    const payment = (reservation, amount, id = '1001') => ({
      id, status: 'approved', external_reference: reservation.purchaseId, transaction_amount: amount, currency_id: 'ARS',
    });
    const rowOf = async (id) => (await pool.query(
      'SELECT payment_status, mp_payment_id, oversold, review_reason FROM public.ventas WHERE id = $1', [id]
    )).rows[0];

    test('NEGATIVO: un pago por menos del total no salda y deja la marca amount_mismatch', async () => {
      const { reservation } = await reserveMp();
      assert.equal(await settleApprovedPayment(payment(reservation, 10)), -1);
      const row = await rowOf(reservation.orderIds[0]);
      assert.equal(row.payment_status, 'pendiente');
      assert.equal(row.review_reason, 'amount_mismatch');
    });

    test('POSITIVO: pago correcto salda una vez; el replay no cuenta; un 2.º pago distinto queda duplicate_payment', async () => {
      const { reservation, total } = await reserveMp();
      assert.equal(await settleApprovedPayment(payment(reservation, total)), 1);
      assert.equal(await settleApprovedPayment(payment(reservation, total)), 0);
      assert.equal(await settleApprovedPayment(payment(reservation, total, '2002')), 0);
      const row = await rowOf(reservation.orderIds[0]);
      assert.equal(row.payment_status, 'pagado');
      assert.equal(row.mp_payment_id, '1001');
      assert.equal(row.review_reason, 'duplicate_payment');
    });

    test('pago tardío: con stock se vuelve a descontar; sin stock queda oversold y el stock nunca es negativo', async () => {
      const { productId, reservation, total } = await reserveMp(2, 2);
      assert.equal(await Order.expireMpByIds(reservation.orderIds), 1);
      assert.equal((await readProduct(productId)).stock, 2);
      assert.equal(await settleApprovedPayment(payment(reservation, total)), 1);
      assert.equal((await readProduct(productId)).stock, 0);
      assert.equal((await rowOf(reservation.orderIds[0])).oversold, false);

      const other = await reserveMp(2, 2);
      await Order.expireMpByIds(other.reservation.orderIds);
      assert.equal((await buy(await createUser(), other.productId, 2)).ok, true);
      assert.equal(await settleApprovedPayment(payment(other.reservation, other.total, '3003')), 1);
      const late = await rowOf(other.reservation.orderIds[0]);
      assert.equal(late.payment_status, 'pagado');
      assert.equal(late.oversold, true);
      assert.equal((await readProduct(other.productId)).stock, 0);
    });

    test('cancelar devuelve unidades y talle una sola vez (doble cancelación simultánea)', async () => {
      const variants = [{ name: 'Talle', options: ['M'], stockByOption: { M: 3 } }];
      const productId = await createProduct({ stock: 3, variants });
      const reservation = await buy(await createUser(), productId, 2, { unitsConfig: [{ Talle: 'M' }, { Talle: 'M' }] });
      assert.equal(reservation.ok, true);
      assert.equal((await readProduct(productId)).variants[0].stockByOption.M, 1);
      const cancel = () => withTransaction('qa_cancel', async (client) => {
        const rows = await Order.findByIdsForUpdate(client, reservation.orderIds);
        return Order.cancelLockedPending(client, rows);
      });
      const [first, second] = await Promise.all([cancel(), cancel()]);
      assert.equal(first + second, 1);
      const product = await readProduct(productId);
      assert.equal(product.stock, 3);
      assert.equal(product.variants[0].stockByOption.M, 3);
    });
  });

  describe('SQL de modelos que los tests con base simulada no ejecutan', () => {
    test('IdempotencyKey: guarda, lee solo lo vigente, reemplaza y purga', async () => {
      const IdempotencyKey = require(path.join(root, 'models/IdempotencyKey.js'));
      const scope = `transfer:${crypto.randomUUID()}`;
      await IdempotencyKey.save(scope, 'clave-12345678', { fingerprint: 'f1', status: 201, body: { success: true } });
      const fresh = await IdempotencyKey.findFresh(scope, 'clave-12345678', 600);
      assert.equal(fresh.fingerprint, 'f1');
      assert.deepEqual(fresh.body, { success: true });
      assert.equal(await IdempotencyKey.findFresh(`transfer:${crypto.randomUUID()}`, 'clave-12345678', 600), null, 'otro usuario no lo ve');
      await IdempotencyKey.save(scope, 'clave-12345678', { fingerprint: 'f2', status: 201, body: {} });
      assert.equal((await IdempotencyKey.findFresh(scope, 'clave-12345678', 600)).fingerprint, 'f2');
      await pool.query("UPDATE public.idempotency_keys SET created_at = NOW() - interval '2 days' WHERE scope = $1", [scope]);
      assert.equal(await IdempotencyKey.findFresh(scope, 'clave-12345678', 600), null, 'vencida');
      assert.ok(await IdempotencyKey.purgeOlderThan(24) >= 1);
    });

    test('findPurchasesByEmail pagina, ordena y solo devuelve pagadas o transferencias avisadas', async () => {
      const email = `${crypto.randomUUID()}@example.test`;
      const productId = await createProduct({ stock: 50 });
      const userId = await createUser();
      const place = (method) => reserveOrders({
        buyerName: 'Cliente QA', buyerEmail: email, userId, items: [{ productId, productName: 'x', quantity: 1, unitPrice: 1, totalPrice: 1 }],
        shippingMethod: 'local', shippingCost: 0, paymentMethod: method,
      });
      const paid = await place('transfer');
      const notified = await place('transfer');
      await place('transfer');
      await pool.query("UPDATE public.ventas SET payment_status = 'pagado' WHERE id = $1", [paid.orderIds[0]]);
      await pool.query("UPDATE public.ventas SET origin = 'wa_confirmado' WHERE id = $1", [notified.orderIds[0]]);
      const all = await Order.findPurchasesByEmail(email.toUpperCase(), 10, 0);
      assert.equal(all.total, 2);
      assert.equal(all.rows.length, 2);
      const page = await Order.findPurchasesByEmail(email, 1, 1);
      assert.equal(page.rows.length, 1);
      assert.equal(page.total, 2);
    });

    test('expireStaleTransfers y conciliación de cerradas: consultas válidas y devuelven el stock', async () => {
      const productId = await createProduct({ stock: 4 });
      const reservation = await buy(await createUser(), productId, 2);
      await pool.query("UPDATE public.ventas SET created_at = NOW() - interval '6 hours' WHERE id = $1", [reservation.orderIds[0]]);
      assert.ok(await Order.expireStaleTransfers(5) >= 1);
      assert.equal((await readProduct(productId)).stock, 4);

      const OrderPayment = require(path.join(root, 'models/OrderPayment.js'));
      const mp = await buy(await createUser(), productId, 1, { paymentMethod: 'mp' });
      await Order.expireMpByIds(mp.orderIds);
      const references = await OrderPayment.findRecentlyClosedMpReferences(48, 200);
      assert.ok(references.includes(mp.purchaseId));
      assert.equal(await OrderPayment.setReviewReason(mp.orderIds, 'refunded', { status: 'paid' }), 0, 'no paga: no se marca como pagada-revisada');
      assert.deepEqual(await OrderPayment.findMissingPaymentColumns(), []);
    });

    test('devolución de un pago saldado: queda review_reason sin tocar estado ni stock', async () => {
      const productId = await createProduct({ stock: 3 });
      const reservation = await buy(await createUser(), productId, 1, { paymentMethod: 'mp' });
      const base = { id: '7001', external_reference: reservation.purchaseId, transaction_amount: 1000, currency_id: 'ARS' };
      await settleApprovedPayment({ ...base, status: 'approved' });
      const { flagReversedPayment } = require(path.join(root, 'utils/paymentSettlement.js'));
      assert.equal(await flagReversedPayment({ ...base, status: 'approved', transaction_amount_refunded: 400 }), 1);
      const row = (await pool.query('SELECT payment_status, review_reason FROM public.ventas WHERE id = $1', [reservation.orderIds[0]])).rows[0];
      assert.equal(row.payment_status, 'pagado');
      assert.equal(row.review_reason, 'refunded');
      assert.equal((await readProduct(productId)).stock, 2);
      assert.equal(await flagReversedPayment({ ...base, id: '9999', status: 'charged_back' }), 0, 'otro pago distinto no marca');
    });
  });

  describe('barrido de vencidas', () => {
    test('findStaleMpOrders excluye las compras ya consultadas (no quedan siempre las mismas)', async () => {
      const productId = await createProduct({ stock: 10 });
      const one = await buy(await createUser(), productId, 1, { paymentMethod: 'mp' });
      const two = await buy(await createUser(), productId, 1, { paymentMethod: 'mp' });
      await pool.query(
        "UPDATE public.ventas SET created_at = NOW() - interval '2 hours' WHERE mp_external_reference = ANY($1)",
        [[one.purchaseId, two.purchaseId]]
      );
      const all = await Order.findStaleMpOrders(15, 200, []);
      assert.ok(all.some((row) => row.mp_external_reference === one.purchaseId));
      const skipped = await Order.findStaleMpOrders(15, 200, [one.purchaseId]);
      assert.ok(!skipped.some((row) => row.mp_external_reference === one.purchaseId));
      assert.ok(skipped.some((row) => row.mp_external_reference === two.purchaseId));
    });
  });

  describe('auditoría con actor (SEC-L01)', () => {
    const lastActor = async (productId) => (await pool.query(
      "SELECT actor FROM public.audit_log WHERE table_name = 'productos' AND row_id = $1 ORDER BY id DESC LIMIT 1",
      [productId]
    )).rows[0].actor;

    test('POSITIVO: un cambio de precio hecho por la API queda atribuido al admin', async () => {
      const productId = await createProduct({ stock: 1, price: 100 });
      const admin = await createUser();
      await Product.update(productId, { price: 250 }, undefined, admin);
      assert.equal(await lastActor(productId), admin);
    });

    test('NEGATIVO: sin actor queda NULL y un actor mal formado no rompe la escritura ni se interpreta como SQL', async () => {
      const productId = await createProduct({ stock: 1, price: 100 });
      await Product.update(productId, { price: 300 }, undefined, undefined);
      assert.equal(await lastActor(productId), null);
      await Product.update(productId, { price: 310 }, undefined, "not-a-uuid'; DROP TABLE ventas;--");
      assert.equal(await lastActor(productId), null);
      assert.equal((await pool.query("SELECT to_regclass('public.ventas') AS t")).rows[0].t, 'ventas');
    });

    test('NEGATIVO: el actor no se arrastra a la siguiente transacción de la misma conexión', async () => {
      const productId = await createProduct({ stock: 1, price: 100 });
      const admin = await createUser();
      await Product.update(productId, { price: 120 }, undefined, admin);
      await pool.query('UPDATE public.productos SET price = 130 WHERE id = $1', [productId]);
      assert.equal(await lastActor(productId), null);
    });
  });
});
