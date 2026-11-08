/**
 * H-04: invalidación selectiva del catálogo. Una reserva o liberación común NO vacía las cachés; sí lo hace
 * un cambio que agota/revive un producto (o un talle) y cualquier cambio del admin.
 * Base en memoria con rollback y locks (ver helpers/fakeCheckoutDb.js).
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubModule, abs } = require('./helpers/harness');
const { createFakeCheckoutDb } = require('./helpers/fakeCheckoutDb');

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

const { reserveOrders, releaseOrders } = require(abs('services/checkoutReservation.js'));
const { caches, invalidateProducts } = require(abs('utils/cache.js'));
const { availabilityChanged } = require(abs('utils/catalogInvalidation.js'));

const USER_ID = '22222222-2222-4222-8222-222222222222';

const reserve = (quantity) => reserveOrders({
  buyerName: 'Cliente Prueba',
  buyerEmail: 'buyer@example.test',
  userId: USER_ID,
  items: [{ productId: '7', productName: 'Remera', quantity, unitPrice: 1000, totalPrice: 1000 * quantity, unitsConfig: [] }],
  shippingMethod: 'local',
  paymentMethod: 'transfer',
  expectedTotal: 1000 * quantity,
});

const seedCaches = () => {
  caches.catalog.set('catalog:page', { items: [1] }, 60000);
  caches.catalogFacets.set('facets:[]', { sizes: ['M'], colors: [] }, 60000);
  caches.products.set('detail:public:7', { id: '7' }, 60000);
};
const cachesAreWarm = () =>
  caches.catalog.get('catalog:page') !== undefined
  && caches.catalogFacets.get('facets:[]') !== undefined
  && caches.products.get('detail:public:7') !== undefined;
const cachesAreEmpty = () =>
  caches.catalog.get('catalog:page') === undefined
  && caches.catalogFacets.get('facets:[]') === undefined
  && caches.products.get('detail:public:7') === undefined;

describe('H-04: reservas y liberaciones de stock', () => {
  beforeEach(() => {
    invalidateProducts();
  });

  test('una reserva común (queda stock) NO vacía el catálogo', async () => {
    db = createFakeCheckoutDb({ stock: 10 });
    seedCaches();
    const result = await reserve(2);
    assert.equal(result.ok, true);
    assert.equal(db.state.product.stock, 8);
    assert.ok(cachesAreWarm(), 'las cachés siguen calientes');
  });

  test('una reserva que deja el producto en 0 SÍ vacía el catálogo (cambia la disponibilidad)', async () => {
    db = createFakeCheckoutDb({ stock: 2 });
    seedCaches();
    assert.equal((await reserve(2)).ok, true);
    assert.equal(db.state.product.stock, 0);
    assert.ok(cachesAreEmpty());
  });

  test('liberar stock de un producto que NO estaba agotado no vacía el catálogo', async () => {
    db = createFakeCheckoutDb({ stock: 10 });
    const { orderIds } = await reserve(1);
    seedCaches();
    await releaseOrders(orderIds);
    assert.equal(db.state.product.stock, 10);
    assert.ok(cachesAreWarm());
  });

  test('liberar stock que revive un producto agotado SÍ vacía el catálogo', async () => {
    db = createFakeCheckoutDb({ stock: 1 });
    const { orderIds } = await reserve(1);
    seedCaches();
    await releaseOrders(orderIds);
    assert.equal(db.state.product.stock, 1);
    assert.ok(cachesAreEmpty());
  });

  test('una reserva rechazada por falta de stock no vacía nada', async () => {
    db = createFakeCheckoutDb({ stock: 1 });
    seedCaches();
    const result = await reserve(5);
    assert.equal(result.ok, false);
    assert.ok(cachesAreWarm());
  });
});

describe('H-04: cambios del admin', () => {
  test('invalidateProducts vacía páginas, detalle, facets y vacíos', () => {
    seedCaches();
    caches.catalogMisses.set('catalog:junk', { items: [] }, 60000);
    caches.productMisses.set('detail:public:9', true, 60000);
    invalidateProducts();
    assert.ok(cachesAreEmpty());
    assert.equal(caches.catalogMisses.get('catalog:junk'), undefined);
    assert.equal(caches.productMisses.get('detail:public:9'), undefined);
  });
});

describe('H-04: availabilityChanged (puro)', () => {
  const sized = (stockByOption) => [{ name: 'Talle', options: Object.keys(stockByOption), stockByOption }];

  test('el stock total cambia de disponible a agotado y viceversa', () => {
    assert.equal(availabilityChanged({ stock: 1, variants: null }, { stock: 0, variants: null }), true);
    assert.equal(availabilityChanged({ stock: 0, variants: null }, { stock: 3, variants: null }), true);
  });

  test('el stock baja pero sigue habiendo: no cambia', () => {
    assert.equal(availabilityChanged({ stock: 9, variants: null }, { stock: 8, variants: null }), false);
  });

  test('un talle se agota aunque el total siga > 0: cambia (cambian los facets)', () => {
    const before = { stock: 5, variants: sized({ M: 1, L: 4 }) };
    const after = { stock: 4, variants: sized({ M: 0, L: 4 }) };
    assert.equal(availabilityChanged(before, after), true);
  });

  test('un talle baja de 4 a 3: no cambia', () => {
    const before = { stock: 5, variants: sized({ M: 1, L: 4 }) };
    const after = { stock: 4, variants: sized({ M: 1, L: 3 }) };
    assert.equal(availabilityChanged(before, after), false);
  });

  test('stock desconocido (NULL, sin control) no dispara invalidación', () => {
    assert.equal(availabilityChanged({ stock: null, variants: null }, { stock: null, variants: null }), false);
  });
});
