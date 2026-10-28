const test = require('node:test');
const assert = require('node:assert/strict');
const { createWithdrawalSchema, updateWithdrawalSchema } = require('../../schemas/withdrawalSchema');

const valid = { name: 'Ana', email: 'ana@example.test', description: 'Campera negra, 6/10', orderNumber: 1001 };
const parse = (overrides) => createWithdrawalSchema.safeParse({ ...valid, ...overrides });

test('arrepentimiento: normaliza nombre, email (minúsculas) y descripción', () => {
  const result = parse({ name: '  Ana ', email: '  ANA@Example.TEST ', description: ' Campera ' });
  assert.equal(result.success, true);
  assert.deepEqual(result.data, { name: 'Ana', email: 'ana@example.test', description: 'Campera', orderNumber: 1001 });
});

test('arrepentimiento: pedido, fecha e importe son opcionales (ausentes, vacíos o null)', () => {
  const { orderNumber, ...withoutOrder } = valid;
  assert.equal(createWithdrawalSchema.safeParse(withoutOrder).success, true);
  ['orderNumber', 'purchaseDate', 'purchaseAmount'].forEach((field) => {
    assert.equal(parse({ [field]: '' }).data[field], undefined);
    assert.equal(parse({ [field]: null }).data[field], undefined);
  });
});

test('arrepentimiento: valida fecha de compra e importe', () => {
  assert.equal(parse({ purchaseDate: '2026-10-06' }).data.purchaseDate, '2026-10-06');
  assert.equal(parse({ purchaseAmount: '15000.5' }).data.purchaseAmount, 15000.5);
  ['2026-13-01', '2026-02-31', '06/10/2026', '2999-01-01', 'ayer'].forEach((purchaseDate) => {
    assert.equal(parse({ purchaseDate }).success, false, purchaseDate);
  });
  [0, -1, 'abc', 1e12].forEach((purchaseAmount) => {
    assert.equal(parse({ purchaseAmount }).success, false, String(purchaseAmount));
  });
});

test('arrepentimiento: acepta el número de pedido como número o como texto numérico', () => {
  assert.equal(parse({ orderNumber: 1001 }).data.orderNumber, 1001);
  assert.equal(parse({ orderNumber: '1001' }).data.orderNumber, 1001);
});

test('arrepentimiento: rechaza número de pedido 0, negativo, decimal, texto o fuera de rango', () => {
  [0, -5, 1.5, 'abc', '12abc', 2147483648, {}, []].forEach((orderNumber) => {
    assert.equal(parse({ orderNumber }).success, false, `orderNumber ${JSON.stringify(orderNumber)}`);
  });
});

test('arrepentimiento: rechaza campos vacíos, email inválido y textos largos', () => {
  assert.equal(parse({ name: '   ' }).success, false);
  assert.equal(parse({ description: '   ' }).success, false);
  assert.equal(parse({ email: 'sin-arroba' }).success, false);
  assert.equal(parse({ email: `${'a'.repeat(250)}@example.test` }).success, false);
  assert.equal(parse({ name: 'A'.repeat(101) }).success, false);
  assert.equal(parse({ description: 'x'.repeat(501) }).success, false);
  assert.equal(parse({ description: 'x'.repeat(500) }).success, true);
});

test('arrepentimiento: campos extra (mass assignment) se rechazan', () => {
  assert.equal(parse({ status: 'resuelta' }).success, false);
  assert.equal(parse({ code: 'ARR-2026-0001' }).success, false);
});

test('arrepentimiento: tolera emojis y caracteres especiales en el texto', () => {
  assert.equal(parse({ description: 'Remera 👕 "azul" <b>talle M</b> ñandú' }).success, true);
});

test('admin: el update pide estado o nota, valida el estado y la nota vacía pasa a null', () => {
  assert.equal(updateWithdrawalSchema.safeParse({}).success, false);
  assert.equal(updateWithdrawalSchema.safeParse({ status: 'otro' }).success, false);
  assert.equal(updateWithdrawalSchema.safeParse({ status: 'en_gestion' }).success, true);
  assert.equal(updateWithdrawalSchema.parse({ adminNote: '  ' }).adminNote, null);
  assert.equal(updateWithdrawalSchema.safeParse({ adminNote: 'x'.repeat(1001) }).success, false);
  assert.equal(updateWithdrawalSchema.safeParse({ status: 'resuelta', resolvedAt: 'x' }).success, false);
});
