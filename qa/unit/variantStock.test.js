const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEDUCT, RESTORE, REASON, findSizeStockVariant, validateSizeStock, applySizeDelta,
} = require('../../utils/variantStock');

const variants = () => [
  { name: 'Color', options: ['Rojo', 'Azul'] },
  { name: 'Talle', options: ['M', 'L'], stockByOption: { M: 1, L: 3 } },
];
const unit = (size) => ({ Color: 'Rojo', Talle: size });

test('sin variante de talle con stock por opción no hay nada que validar ni ajustar', () => {
  const noTracking = [{ name: 'Talle', options: ['M'] }];
  assert.equal(findSizeStockVariant(noTracking), null);
  assert.deepEqual(validateSizeStock(noTracking, [], 2), { ok: true });
  assert.equal(applySizeDelta(noTracking, [unit('M')], DEDUCT), null);
  assert.equal(applySizeDelta(undefined, [unit('M')], DEDUCT), null);
});

test('rechaza el talle agotado aunque el total del producto alcance (el bug original)', () => {
  const result = validateSizeStock(variants(), [unit('M'), unit('M')], 2);
  assert.deepEqual(result, { ok: false, reason: REASON.noStockForSize, size: 'M' });
});

test('acepta unidades repartidas entre talles con stock', () => {
  assert.deepEqual(validateSizeStock(variants(), [unit('M'), unit('L'), unit('L')], 3), { ok: true });
});

test('exige un talle por unidad y que coincida con la cantidad', () => {
  assert.equal(validateSizeStock(variants(), [], 1).reason, REASON.missingSize);
  assert.equal(validateSizeStock(variants(), [{ Color: 'Rojo' }], 1).reason, REASON.missingSize);
  assert.equal(validateSizeStock(variants(), [unit('L')], 2).reason, REASON.missingSize);
});

test('rechaza un talle que no existe en el producto', () => {
  assert.deepEqual(validateSizeStock(variants(), [unit('XXL')], 1), {
    ok: false, reason: REASON.unknownSize, size: 'XXL',
  });
});

test('normaliza el talle (minúsculas y espacios)', () => {
  assert.deepEqual(validateSizeStock(variants(), [unit(' l ')], 1), { ok: true });
});

test('descontar baja solo el talle comprado y no muta el original', () => {
  const original = variants();
  const next = applySizeDelta(original, [unit('M'), unit('L')], DEDUCT);
  assert.deepEqual(next[1].stockByOption, { M: 0, L: 2 });
  assert.deepEqual(original[1].stockByOption, { M: 1, L: 3 });
  assert.equal(next[0], original[0]);
});

test('descontar nunca deja stock negativo', () => {
  const next = applySizeDelta(variants(), [unit('M'), unit('M'), unit('M')], DEDUCT);
  assert.equal(next[1].stockByOption.M, 0);
});

test('restaurar devuelve el stock al talle y descontar+restaurar es neutro', () => {
  const units = [unit('M'), unit('L'), unit('L')];
  const deducted = applySizeDelta(variants(), units, DEDUCT);
  const restored = applySizeDelta(deducted, units, RESTORE);
  assert.deepEqual(restored[1].stockByOption, { M: 1, L: 3 });
});

test('restaurar ignora talles que el admin ya quitó', () => {
  const edited = [{ name: 'Talle', options: ['L'], stockByOption: { L: 3 } }];
  assert.equal(applySizeDelta(edited, [unit('M')], RESTORE), null);
  const next = applySizeDelta(edited, [unit('M'), unit('L')], RESTORE);
  assert.deepEqual(next[0].stockByOption, { L: 4 });
});

test('unitsConfig ausente o inválido en restaurar no rompe (órdenes viejas)', () => {
  assert.equal(applySizeDelta(variants(), null, RESTORE), null);
  assert.equal(applySizeDelta(variants(), 'x', RESTORE), null);
});
