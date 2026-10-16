const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPreferencePayload } = require('../../utils/mpPreference');
const { buildProductAssignments, buildProductUpdateStatement } = require('../../utils/productUpdateQuery');

const order = {
  buyerName: ' Ana ',
  buyerEmail: 'ana@x.com',
  items: [{ productName: 'Remera', productImage: null, quantity: 2, unitPrice: 1000 }],
  shippingCost: 4400,
  purchaseId: '3f2b8c1e-9d4a-4b7e-8f00-123456789abc',
};

test('preferencia: external_reference es el id de compra (corto) y excluye medios diferidos', () => {
  const pref = buildPreferencePayload(order, { origin: 'http://localhost:5173', webhookUrl: '', now: 0 });
  assert.equal(pref.external_reference, order.purchaseId);
  assert.ok(pref.external_reference.length <= 256);
  assert.deepEqual(pref.payment_methods, { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] });
  assert.equal(pref.expiration_date_to, new Date(15 * 60 * 1000).toISOString());
  assert.equal(pref.auto_return, undefined);
  assert.equal(pref.notification_url, undefined);
  assert.equal(pref.items.at(-1).title, 'Envío');
  assert.equal(pref.payer.name, 'Ana');
});

test('preferencia: auto_return y webhook solo con URL pública / configurada', () => {
  const pref = buildPreferencePayload(order, { origin: 'https://tienda.com', webhookUrl: 'https://api/hook' });
  assert.equal(pref.auto_return, 'approved');
  assert.equal(pref.notification_url, 'https://api/hook');
});

test('producto: sin `stock` en el body el UPDATE no toca la columna stock', () => {
  const columns = buildProductAssignments({ name: 'X', price: '10' }).map(([column]) => column);
  assert.deepEqual(columns, ['name', 'price']);
  assert.ok(!columns.includes('stock'));
  assert.ok(buildProductAssignments({ stock: 0 }).some(([column, value]) => column === 'stock' && value === 0));
});

test('producto: images sincroniza image_url con la primera imagen', () => {
  assert.deepEqual(buildProductAssignments({ images: ['a', 'b'] }), [['images', '["a","b"]'], ['image_url', 'a']]);
  assert.deepEqual(buildProductAssignments({ imageUrl: 'u' }), [['image_url', 'u']]);
});

test('producto: expectedUpdatedAt va en el WHERE del mismo UPDATE (atómico)', () => {
  const stamp = '2026-10-12T15:00:00.123456+00:00';
  const statement = buildProductUpdateStatement('5', [['name', 'X']], stamp);
  assert.match(statement.text, /WHERE id = \$2 AND updated_at = \$3::timestamptz RETURNING \*/);
  assert.deepEqual(statement.values, ['X', '5', stamp]);
  const plain = buildProductUpdateStatement('5', [['name', 'X']], undefined);
  assert.match(plain.text, /WHERE id = \$2 RETURNING \*$/);
  assert.deepEqual(plain.values, ['X', '5']);
});
