const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, startApp, abs } = require('../../test/helpers/harness');

process.env.LOG_LEVEL = 'error';

const KNOWN_PRODUCT = { id: '7', name: 'Remera', price: 100, stock: 3, status: 'active' };

const pool = installFakeDatabase((sql, params) => {
  if (sql.includes('COUNT(*) OVER()')) return { rows: [] };
  if (sql.includes('COUNT(*)::int AS total')) return { rows: [{ total: 1 }] };
  if (sql.includes('WHERE id = $1')) return { rows: params[0] === KNOWN_PRODUCT.id ? [KNOWN_PRODUCT] : [] };
  return undefined;
});

const { caches } = require(abs('utils/cache.js'));

let app;
test.before(async () => { app = await startApp([['/api/products', 'routes/productRoutes.js']]); });
test.after(() => app.close());

const detailQueries = () => pool.queries.filter((query) => query.sql.includes('WHERE id = $1')).length;

test('catálogo: un offset enorme se acota a 10000 (no genera una clave de caché por cada valor)', async () => {
  const response = await fetch(`${app.baseUrl}/api/products?offset=999999999999`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.offset, 10000);
  assert.deepEqual(body.data, []);
  assert.equal(caches.products.stats().size, 1, 'una sola entrada, no una por offset distinto');
});

test('detalle: un id inexistente se recuerda en la caché de "no existe" y NO ensucia la del catálogo', async () => {
  const sizeBefore = caches.products.stats().size;
  const first = await fetch(`${app.baseUrl}/api/products/123456`);
  const second = await fetch(`${app.baseUrl}/api/products/123456`);
  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(detailQueries(), 1, 'la segunda consulta no llegó a la base');
  assert.equal(caches.products.stats().size, sizeBefore, 'el catálogo no guardó el null');
  assert.equal(caches.productMisses.stats().size, 1);
});

test('detalle: un producto existente se sirve y se cachea normalmente', async () => {
  const before = detailQueries();
  const first = await (await fetch(`${app.baseUrl}/api/products/${KNOWN_PRODUCT.id}`)).json();
  await fetch(`${app.baseUrl}/api/products/${KNOWN_PRODUCT.id}`);
  assert.equal(first.data.name, 'Remera');
  assert.equal(detailQueries() - before, 1);
});

test('invalidar el catálogo también olvida los ids que "no existían" (puede haberse creado ese producto)', () => {
  const { invalidateProducts } = require(abs('utils/cache.js'));
  invalidateProducts();
  assert.equal(caches.productMisses.stats().size, 0);
  assert.equal(caches.products.stats().size, 0);
});
