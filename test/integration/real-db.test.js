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

const createProduct = async ({ stock, variants = null, price = 1000, status = 'active' }) => {
  const { rows } = await pool.query(
    `INSERT INTO public.productos (name, price, stock, variants, status)
     VALUES ('Producto QA integración', $1, $2, $3, $4) RETURNING id`,
    [price, stock, variants ? JSON.stringify(variants) : null, status]
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
  // El servidor frena la compra si el total que vio el comprador no coincide: createProduct usa precio 1000.
  expectedTotal: extra.expectedTotal ?? 1000 * quantity,
  idempotency: extra.idempotency || null,
});

// El pool se comparte entre los describe de este archivo: se cierra una sola vez, al final de todos.
after(async () => {
  if (pool) await pool.end();
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
    const proposed = fs.readFileSync(path.join(root, 'db/migrations/2026-10-16_audit_actor.sql'), 'utf8');
    await pool.query(proposed);
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
      shippingMethod: 'local', paymentMethod: 'transfer', expectedTotal: 2000,
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

  describe('idempotencia en base (H-03) y tope por usuario (S-01)', () => {
    const attempt = () => ({ key: `k-${crypto.randomUUID()}`, fingerprint: 'abcdef012345' });
    const pendingUnitsOf = async (userId) => (await pool.query(
      "SELECT COALESCE(SUM(quantity), 0)::int AS units FROM public.ventas WHERE user_id = $1 AND payment_status = 'pendiente'", [userId]
    )).rows[0].units;

    test('S-01: 6 reservas de 20 unidades en paralelo del mismo usuario dejan como máximo 60 unidades pendientes', async () => {
      const productId = await createProduct({ stock: 500 });
      const user = await createUser();
      const results = await Promise.all(Array.from({ length: 6 }, () => buy(user, productId, 20)));
      assert.equal(results.filter((r) => r.ok).length, 3);
      assert.ok(results.filter((r) => !r.ok).every((r) => r.status === 429));
      assert.equal(await pendingUnitsOf(user), 60);
      assert.equal((await readProduct(productId)).stock, 440);
    });

    test('H-03: el reintento con la misma key reenvía la orden, sin descontar otra vez, y la fila guarda <key>:<huella>:0', async () => {
      const productId = await createProduct({ stock: 10 });
      const user = await createUser();
      const idempotency = attempt();
      const first = await buy(user, productId, 2, { idempotency });
      const retry = await buy(user, productId, 2, { idempotency });
      assert.equal(first.ok && retry.ok, true);
      assert.equal(retry.replayed, true);
      assert.deepEqual(retry.orderIds, first.orderIds);
      assert.equal(retry.orderNumber, first.orderNumber);
      assert.equal((await readProduct(productId)).stock, 8);
      const { rows } = await pool.query('SELECT idempotency_key FROM public.ventas WHERE id = $1::uuid', [first.orderIds[0]]);
      assert.equal(rows[0].idempotency_key, `${idempotency.key}:${idempotency.fingerprint}:0`);
    });

    test('H-03 carrera: 10 requests simultáneas con la misma key crean un solo intento y descuentan una sola vez', async () => {
      const productId = await createProduct({ stock: 10 });
      const user = await createUser();
      const idempotency = attempt();
      const results = await Promise.all(Array.from({ length: 10 }, () => buy(user, productId, 1, { idempotency })));
      assert.ok(results.every((r) => r.ok), JSON.stringify(results.find((r) => !r.ok)));
      assert.equal(results.filter((r) => !r.replayed).length, 1);
      assert.equal(await countVentas(productId), 1);
      assert.equal((await readProduct(productId)).stock, 9);
    });

    test('H-03: tras cancelar o vencer la orden, la misma key crea un intento nuevo y libera la key vieja', async () => {
      const productId = await createProduct({ stock: 10 });
      const user = await createUser();
      const idempotency = attempt();
      const first = await buy(user, productId, 1, { idempotency });
      await withTransaction('test_cancel', async (client) => {
        const rows = await Order.findByIdsForUpdate(client, first.orderIds);
        await Order.cancelLockedPending(client, rows);
      });
      assert.equal((await readProduct(productId)).stock, 10);
      const retry = await buy(user, productId, 1, { idempotency });
      assert.equal(retry.ok, true);
      assert.notEqual(retry.replayed, true);
      assert.notDeepEqual(retry.orderIds, first.orderIds);
      assert.equal((await readProduct(productId)).stock, 9);
      const old = await pool.query('SELECT idempotency_key, payment_status FROM public.ventas WHERE id = $1::uuid', [first.orderIds[0]]);
      assert.deepEqual([old.rows[0].idempotency_key, old.rows[0].payment_status], [null, 'cancelado']);
    });

    test('H-03: una orden ya pagada con esa key responde 409 y no crea otra', async () => {
      const productId = await createProduct({ stock: 10 });
      const user = await createUser();
      const idempotency = attempt();
      const first = await buy(user, productId, 1, { idempotency });
      await pool.query("UPDATE public.ventas SET payment_status = 'pagado' WHERE id = $1::uuid", [first.orderIds[0]]);
      const retry = await buy(user, productId, 1, { idempotency });
      assert.deepEqual([retry.ok, retry.status, retry.code], [false, 409, 'CHECKOUT_ATTEMPT_CLOSED']);
      assert.equal(await countVentas(productId), 1);
    });

    test('H-03: la misma key con otro carrito responde 422 y no toca el stock', async () => {
      const productId = await createProduct({ stock: 10 });
      const user = await createUser();
      const idempotency = attempt();
      await buy(user, productId, 1, { idempotency });
      const other = await buy(user, productId, 1, { idempotency: { ...idempotency, fingerprint: '0123456789ab' } });
      assert.deepEqual([other.ok, other.status, other.code], [false, 422, 'IDEMPOTENCY_KEY_REUSED']);
      assert.equal((await readProduct(productId)).stock, 9);
    });

    test('H-03 respaldo: un 23505 del índice único a mitad de la reserva deshace el descuento del trigger y no deja órdenes huérfanas', async () => {
      const productId = await createProduct({ stock: 10 });
      const user = await createUser();
      const idempotency = attempt();
      const row = (index) => ({
        buyerName: 'Cliente QA', buyerEmail: 'a@example.test', userId: user, productId, productName: 'x', quantity: 1,
        unitPrice: 1000, totalPrice: 1000, paymentMethod: 'transfer', shippingMethod: 'local',
        idempotencyKey: `${idempotency.key}:${idempotency.fingerprint}:${index}`,
      });
      await withTransaction('seed_other_attempt', (client) => Order.insertPending(client, row(1)));
      assert.equal((await readProduct(productId)).stock, 9);
      await assert.rejects(
        withTransaction('conflict', async (client) => {
          await Order.insertPending(client, row(0));
          await Order.insertPending(client, row(1));
        }),
        (error) => error.code === '23505'
      );
      assert.equal((await readProduct(productId)).stock, 9, 'el INSERT de la línea 0 y su descuento se deshicieron');
      assert.equal(await countVentas(productId), 1);
    });
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
        shippingMethod: 'local', paymentMethod: method, expectedTotal: 1000,
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

    // Inactivos: un producto activo sin categoría ni foto no pasa la regla de publicación (ver abajo).
    test('POSITIVO: un cambio de precio hecho por la API queda atribuido al admin', async () => {
      const productId = await createProduct({ stock: 1, price: 100, status: 'inactive' });
      const admin = await createUser();
      await Product.update(productId, { price: 250 }, undefined, admin);
      assert.equal(await lastActor(productId), admin);
    });

    test('NEGATIVO: sin actor queda NULL y un actor mal formado no rompe la escritura ni se interpreta como SQL', async () => {
      const productId = await createProduct({ stock: 1, price: 100, status: 'inactive' });
      await Product.update(productId, { price: 300 }, undefined, undefined);
      assert.equal(await lastActor(productId), null);
      await Product.update(productId, { price: 310 }, undefined, "not-a-uuid'; DROP TABLE ventas;--");
      assert.equal(await lastActor(productId), null);
      assert.equal((await pool.query("SELECT to_regclass('public.ventas') AS t")).rows[0].t, 'ventas');
    });

    test('NEGATIVO: el actor no se arrastra a la siguiente transacción de la misma conexión', async () => {
      const productId = await createProduct({ stock: 1, price: 100, status: 'inactive' });
      const admin = await createUser();
      await Product.update(productId, { price: 120 }, undefined, admin);
      await pool.query('UPDATE public.productos SET price = 130 WHERE id = $1', [productId]);
      assert.equal(await lastActor(productId), null);
    });
  });

  describe('regla de publicación (Activo = completo)', () => {
    test('NEGATIVO: activar un borrador incompleto se deshace y no escribe nada', async () => {
      const productId = await createProduct({ stock: 0, price: 100, status: 'inactive' });
      const result = await Product.update(productId, { status: 'active', price: 999 }, undefined, undefined);
      assert.deepEqual(result, { status: 'incomplete', missing: 'category' });
      const row = await readProduct(productId);
      assert.equal(row.status, 'inactive');
      assert.equal(Number(row.price), 100);
    });

    test('POSITIVO: un update parcial sobre un producto completo pasa aunque no mande fotos ni talles', async () => {
      const variants = [{ name: 'Color', options: ['Negro'] }, { name: 'Talle', options: ['M'], stockByOption: { M: 2 } }];
      const productId = await createProduct({ stock: 2, price: 100, variants });
      await pool.query(
        "UPDATE public.productos SET category = 'QA', images = $2 WHERE id = $1",
        [productId, JSON.stringify(['https://res.cloudinary.com/qa/image/upload/x.jpg'])]
      );
      const result = await Product.update(productId, { price: 150 }, undefined, undefined);
      assert.equal(result.status, 'updated');
    });
  });
  describe('tanda 2/3: invalidación selectiva, conexiones y preferencias de MP', () => {
    // Se cargan en `before`: el pool lee DB_* al requerirse y el `before` del describe padre ya las fijó.
    let caches;
    let flushAvailabilityChange;
    let OrderPayment;
    before(() => {
      ({ caches } = require(path.join(root, 'utils/cache.js')));
      ({ flushAvailabilityChange } = require(path.join(root, 'utils/catalogInvalidation.js')));
      OrderPayment = require(path.join(root, 'models/OrderPayment.js'));
    });

    const warmCatalog = () => caches.catalog.set('catalog:real-db', { items: [] }, 60000);
    const isWarm = () => caches.catalog.get('catalog:real-db') !== undefined;

    test('H-04: reservar sin agotar no vacía la caché; agotar el producto SÍ (trigger real)', async () => {
      const productId = await createProduct({ stock: 3 });
      const userId = await createUser();
      flushAvailabilityChange();
      warmCatalog();
      assert.equal((await buy(userId, productId, 1)).ok, true);
      assert.equal(isWarm(), true, 'queda stock: sigue caliente');
      assert.equal((await buy(userId, productId, 2)).ok, true);
      assert.equal(isWarm(), false, 'se agotó: se vació');
    });

    test('H-04: liberar la reserva de un producto agotado lo revive y vacía la caché (restoreStock real)', async () => {
      const { releaseOrders } = require(path.join(root, 'services/checkoutReservation.js'));
      const productId = await createProduct({ stock: 1 });
      const userId = await createUser();
      const reserved = await buy(userId, productId, 1);
      assert.equal(reserved.ok, true);
      warmCatalog();
      await releaseOrders(reserved.orderIds);
      assert.equal((await readProduct(productId)).stock, 1);
      assert.equal(isWarm(), false);
    });

    test('H-04: un talle que se agota (aunque el total siga > 0) vacía la caché', async () => {
      const variants = [{ name: 'Talle', options: ['M', 'L'], stockByOption: { M: 1, L: 4 } }];
      const productId = await createProduct({ stock: 5, variants });
      const userId = await createUser();
      flushAvailabilityChange();
      warmCatalog();
      const result = await buy(userId, productId, 1, { unitsConfig: [{ Talle: 'M' }] });
      assert.equal(result.ok, true);
      assert.equal(isWarm(), false);
    });

    test('H-01: findCatalogPage usa UNA conexión a la vez (página y facets en serie)', async () => {
      let inUse = 0;
      let maxInUse = 0;
      const onAcquire = () => { inUse += 1; maxInUse = Math.max(maxInUse, inUse); };
      const onRelease = () => { inUse -= 1; };
      pool.on('acquire', onAcquire);
      pool.on('release', onRelease);
      try {
        await Product.findCatalogPage({ category: [], size: [], color: [], sort: 'newest' }, { offset: 0, limit: 24 });
        await Product.findAdminPage({}, { page: 1, limit: 10 });
      } finally {
        pool.off('acquire', onAcquire);
        pool.off('release', onRelease);
      }
      assert.equal(maxInUse, 1);
    });

    test('S-06: findPreferencesWithoutPendingOrders solo devuelve preferencias sin ventas pendientes', async () => {
      const productId = await createProduct({ stock: 10 });
      const userId = await createUser();
      const prefDone = `pref-done-${Date.now()}`;
      const prefOpen = `pref-open-${Date.now()}`;
      const insert = (pref, status) => pool.query(
        `INSERT INTO public.ventas (buyer_name, buyer_email, user_id, product_id, product_name, quantity, unit_price,
           total_price, payment_method, payment_status, mp_preference_id)
         VALUES ('Cliente QA', 'qa@example.test', $1, $2, 'x', 1, 1, 1, 'mp', $4, $3)`,
        [userId, productId, pref, status]
      );
      await insert(prefDone, 'cancelado');
      await insert(prefDone, 'pagado');
      await insert(prefOpen, 'cancelado');
      await insert(prefOpen, 'pendiente');
      const result = await OrderPayment.findPreferencesWithoutPendingOrders([prefDone, prefOpen, 'pref-inexistente']);
      assert.deepEqual(result.sort(), [prefDone, 'pref-inexistente'].sort());
      assert.deepEqual(await OrderPayment.findPreferencesWithoutPendingOrders([]), []);
    });
  });
});

describe('PostgreSQL real: listado admin con filtros (Product.findAdminPage)', { skip: !enabled }, () => {
  const tag = `QAL${Date.now()}`;
  const sized = (stockByOption) => [{ name: 'Talle', options: Object.keys(stockByOption), stockByOption }];
  const seed = async (name, { stock, variants = null, category = 'QA lista', status = 'active', price = 100 }) => {
    await pool.query(
      `INSERT INTO public.productos (name, price, stock, category, variants, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [`${tag} ${name}`, price, stock, category, variants && JSON.stringify(variants), status]
    );
  };
  const list = async (filters, paging = { page: 1, limit: 50 }) =>
    Product.findAdminPage({ q: tag, ...filters }, paging);
  const names = (result) => result.rows.map((row) => row.name.replace(`${tag} `, ''));

  before(async () => {
    await seed('alfa', { stock: 0, variants: sized({ S: 3, M: 4 }), price: 30 });
    await seed('beta', { stock: 9, price: 10, status: 'inactive' });
    await seed('gamma', { stock: 0, price: 20 });
    await seed('delta', { stock: 4, variants: sized({ S: 0, M: 0 }), price: 40, category: '  qa   otra ' });
    await seed('100%_x', { stock: 2, price: 50 });
  });

  after(async () => {
    await pool.query('DELETE FROM public.productos WHERE name LIKE $1', [`${tag}%`]);
  });

  test('stock efectivo: la suma por talle manda sobre la columna stock', async () => {
    assert.deepEqual(names(await list({ stock: 'in_stock' })).sort(), ['100%_x', 'alfa', 'beta']);
    assert.deepEqual(names(await list({ stock: 'low_stock' })).sort(), ['100%_x']);
    assert.deepEqual(names(await list({ stock: 'out_of_stock' })).sort(), ['delta', 'gamma']);
  });

  test('estado, categoría normalizada y comodines LIKE escapados', async () => {
    assert.deepEqual(names(await list({ status: 'inactive' })), ['beta']);
    assert.deepEqual(names(await list({ category: 'Qa otra' })), ['delta']);
    assert.deepEqual(names(await list({ q: `${tag} 100%_` })), ['100%_x']);
    assert.deepEqual(names(await list({ q: `${tag} 1_0` })), []);
  });

  test('orden determinista y paginación con total', async () => {
    const asc = await list({ sort: 'price_asc' }, { page: 1, limit: 2 });
    assert.deepEqual(names(asc), ['beta', 'gamma']);
    assert.equal(asc.total, 5);
    assert.deepEqual(names(await list({ sort: 'price_asc' }, { page: 3, limit: 2 })), ['100%_x']);
    const beyond = await list({ sort: 'price_asc' }, { page: 9, limit: 2 });
    assert.deepEqual([beyond.rows.length, beyond.total], [0, 5]);
    assert.ok(asc.categories.includes('QA lista') && asc.categories.includes('Qa otra'));
  });
});

describe('PostgreSQL real: catálogo público (Product.findCatalogPage)', { skip: !enabled }, () => {
  const category = `QACAT${Date.now()}`;
  const sized = (stockByOption, extra = {}) => ({ name: 'Talle', options: Object.keys(stockByOption), stockByOption, ...extra });
  const colors = (...options) => ({ name: 'Color', options });
  const seed = (name, { stock = 5, variants = null, status = 'active', price = 100, discount = null, original = null, cat = category }) =>
    pool.query(
      `INSERT INTO public.productos (name, price, stock, category, variants, status, discount, original_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [name, price, stock, cat, variants && JSON.stringify(variants), status, discount, original]
    );
  const find = (filters = {}, paging = { offset: 0, limit: 24 }) =>
    Product.findCatalogPage({ category: [category], size: [], color: [], sort: 'newest', ...filters }, paging);
  const names = (result) => result.items.map((item) => item.name);

  before(async () => {
    await seed('Álamo', { price: 100, variants: [sized({ S: 2, M: 0, L: 3 }, { colorsByOption: { S: ['Rojo'], L: ['Azul'] } }), colors('Rojo', 'Azul', 'Verde')] });
    await seed('beta', { price: 200, discount: 50, variants: [sized({ M: 4 }), colors('Negro')] });
    await seed('Zeta', { price: 300, original: 400, stock: 7, variants: [{ name: 'Talle', options: ['38'] }, colors('Azul')] });
    await seed('Oculto', { status: 'inactive', variants: [sized({ M: 4 }), colors('Negro')] });
    await seed('Roto', { variants: [{ name: 'Talle', options: 'x' }, 'zz', null] });
    await seed('Otra categoría', { cat: `${category}-otra` });
  });

  after(async () => {
    await pool.query('DELETE FROM public.productos WHERE category LIKE $1', [`${category}%`]);
  });

  test('solo activos, categoría sin distinguir mayúsculas, numéricos como número', async () => {
    const result = await Product.findCatalogPage(
      { category: [category.toLowerCase()], size: [], color: [], sort: 'newest' }, { offset: 0, limit: 24 }
    );
    assert.deepEqual(names(result).sort(), ['Roto', 'Zeta', 'beta', 'Álamo']);
    assert.equal(typeof result.items[0].price, 'number');
    assert.equal(Object.keys(result.items[0]).length, 13);
  });

  test('precio efectivo: descuento % y original_price tachado; desempate estable', async () => {
    assert.deepEqual(names(await find({ sort: 'price_asc' })), ['Roto', 'beta', 'Álamo', 'Zeta']);
    assert.deepEqual(names(await find({ sort: 'price_desc' })), ['Zeta', 'Roto', 'beta', 'Álamo']);
  });

  test('nombre sin distinguir mayúsculas ni tildes', async () => {
    assert.deepEqual(names(await find({ sort: 'name_asc' })), ['Álamo', 'beta', 'Roto', 'Zeta']);
  });

  test('talle: con stock por talle manda stockByOption; sin él vale el stock del producto', async () => {
    assert.deepEqual(names(await find({ size: ['m'] })), ['beta']);
    assert.deepEqual(names(await find({ size: ['S', 'M'] })).sort(), ['beta', 'Álamo']);
    assert.deepEqual(names(await find({ size: ['38'] })), ['Zeta']);
  });

  test('color: solo colores de talles con stock; talle y color sobre la misma combinación', async () => {
    assert.deepEqual(names(await find({ color: ['rojo'] })), ['Álamo']);
    assert.deepEqual(names(await find({ color: ['Verde'] })), []);
    assert.deepEqual(names(await find({ size: ['L'], color: ['Azul'] })), ['Álamo']);
    assert.deepEqual(names(await find({ size: ['S'], color: ['Azul'] })), []);
  });

  test('facets: del conjunto filtrado solo por categoría; paginación con hasMore', async () => {
    const result = await find({ size: ['M'] }, { offset: 0, limit: 1 });
    assert.equal(result.hasMore, false);
    assert.deepEqual(result.facets, { sizes: ['S', 'M', 'L', '38'], colors: ['Azul', 'Negro', 'Rojo'] });
    const paged = await find({ sort: 'name_asc' }, { offset: 1, limit: 2 });
    assert.deepEqual([names(paged), paged.hasMore], [['beta', 'Roto'], true]);
  });
});
