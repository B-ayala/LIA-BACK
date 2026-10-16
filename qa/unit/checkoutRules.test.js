const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHECKOUT_ERROR, planReservationLines, evaluateLine, parseProductId, resolveShippingCost,
} = require('../../utils/checkoutRules');
const { validateUnitsConfig } = require('../../utils/unitsConfig');

const product = (overrides = {}) => ({
  name: 'Remera DB',
  image: 'https://img/db.jpg',
  stock: 4,
  price: 1000,
  discount: null,
  original_price: null,
  variants: [
    { name: 'Color', options: ['Rojo', 'Azul'] },
    { name: 'Talle', options: ['M', 'L'], stockByOption: { M: 1, L: 3 } },
  ],
  ...overrides,
});
const line = (item) => ({ item: { productName: 'Nombre del body', quantity: 1, ...item }, productId: '7', index: 0 });

test('parseProductId acepta solo dígitos (string o número)', () => {
  assert.equal(parseProductId('12'), '12');
  assert.equal(parseProductId(12), '12');
  for (const bad of ['', '1a', '-1', '1.5', null, undefined, '1234567890123456789', ' 1']) {
    assert.equal(parseProductId(bad), null, String(bad));
  }
});

test('planReservationLines ordena por productId ascendente y conserva el índice original', () => {
  const plan = planReservationLines([
    { productId: '30', productName: 'c' },
    { productId: '4', productName: 'a' },
    { productId: '30', productName: 'd' },
    { productId: '100', productName: 'b' },
  ]);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.lines.map((l) => [l.productId, l.index]), [['4', 1], ['30', 0], ['30', 2], ['100', 3]]);
});

test('planReservationLines rechaza un productId inválido con INVALID_PRODUCT_ID 400', () => {
  const plan = planReservationLines([{ productId: '5' }, { productId: 'abc', productName: 'X' }]);
  assert.equal(plan.ok, false);
  assert.equal(plan.failure.status, 400);
  assert.equal(plan.failure.code, CHECKOUT_ERROR.invalidProductId);
});

test('nombre, imagen y precio salen de la fila del producto, no del body', () => {
  const result = evaluateLine(product(), line({ unitsConfig: [{ Color: 'Rojo', Talle: 'l' }], productImage: 'evil' }));
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Remera DB');
  assert.equal(result.image, 'https://img/db.jpg');
  assert.equal(result.unitPrice, 1000);
  assert.deepEqual(result.units, [{ Color: 'Rojo', Talle: 'L' }]);
});

test('producto inexistente o sin stock total → OUT_OF_STOCK 409 con productId', () => {
  const missing = evaluateLine(null, line({}));
  assert.equal(missing.code, CHECKOUT_ERROR.outOfStock);
  assert.equal(missing.status, 409);
  assert.equal(missing.productId, '7');
  assert.equal(evaluateLine(product({ stock: 0 }), line({})).code, CHECKOUT_ERROR.outOfStock);
});

test('stock NULL se rechaza (decisión conservadora documentada)', () => {
  assert.equal(evaluateLine(product({ stock: null, variants: null }), line({})).code, CHECKOUT_ERROR.outOfStock);
});

test('talle agotado → SIZE_OUT_OF_STOCK 409 con size', () => {
  const result = evaluateLine(product(), line({
    quantity: 2, unitsConfig: [{ Color: 'Rojo', Talle: 'M' }, { Color: 'Rojo', Talle: 'M' }],
  }));
  assert.deepEqual([result.status, result.code, result.size], [409, CHECKOUT_ERROR.sizeOutOfStock, 'M']);
  assert.match(result.message, /talle M de "Remera DB"/);
});

test('talle que ya no existe → SIZE_UNAVAILABLE 409; sin talle → SIZE_REQUIRED 400', () => {
  const gone = evaluateLine(product(), line({ unitsConfig: [{ Color: 'Rojo', Talle: 'XL' }] }));
  assert.deepEqual([gone.status, gone.code, gone.size], [409, CHECKOUT_ERROR.sizeUnavailable, 'XL']);
  const none = evaluateLine(product(), line({ unitsConfig: [{ Color: 'Rojo' }] }));
  assert.deepEqual([none.status, none.code], [400, CHECKOUT_ERROR.sizeRequired]);
});

test('opción de otra variante inexistente → INVALID_VARIANT 400', () => {
  const result = evaluateLine(product(), line({ unitsConfig: [{ Color: 'Verde', Talle: 'M' }] }));
  assert.deepEqual([result.status, result.code], [400, CHECKOUT_ERROR.invalidVariant]);
});

test('precio no positivo → PRODUCT_UNAVAILABLE 409', () => {
  const result = evaluateLine(product({ price: 0, variants: null }), line({}));
  assert.deepEqual([result.status, result.code], [409, CHECKOUT_ERROR.productUnavailable]);
});

test('envío: método desconocido o moto fuera de rango se rechazan', () => {
  assert.equal(resolveShippingCost('drone', 0).ok, false);
  assert.equal(resolveShippingCost('moto', -1).ok, false);
  assert.deepEqual(resolveShippingCost('local', 999), { ok: true, cost: 0 });
});

test('unitsConfig: producto sin variantes guarda [] aunque el body traiga basura', () => {
  assert.deepEqual(validateUnitsConfig(null, [{ hack: 'x' }], 1), { ok: true, units: [] });
  assert.deepEqual(validateUnitsConfig([{ name: 'Talle', options: [] }], [{}], 1), { ok: true, units: [] });
});

test('unitsConfig: exige una selección por unidad y descarta claves desconocidas', () => {
  const variants = [{ name: 'Color', options: ['Rojo'] }];
  assert.equal(validateUnitsConfig(variants, [{ Color: 'Rojo' }], 2).code, 'INVALID_VARIANT');
  assert.deepEqual(validateUnitsConfig(variants, [{ Color: ' Rojo ', extra: '<script>' }], 1),
    { ok: true, units: [{ Color: 'Rojo' }] });
  assert.equal(validateUnitsConfig(variants, [{ Color: 'rojo' }], 1).code, 'INVALID_VARIANT');
});

test('unitsConfig: talle case-insensitive y sin talle con variantes de talle → SIZE_REQUIRED', () => {
  const variants = [{ name: 'Talle', options: ['M'] }];
  assert.deepEqual(validateUnitsConfig(variants, [{ Talle: ' m ' }], 1), { ok: true, units: [{ Talle: 'M' }] });
  assert.equal(validateUnitsConfig(variants, 'x', 1).code, 'SIZE_REQUIRED');
  assert.equal(validateUnitsConfig(variants, [null], 1).code, 'SIZE_REQUIRED');
});
