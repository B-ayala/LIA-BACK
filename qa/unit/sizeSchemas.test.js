const test = require('node:test');
const assert = require('node:assert/strict');
const { createSizeSchema, updateSizeSchema } = require('../../schemas/sizeSchema');
const { createProductSchema, updateProductSchema } = require('../../schemas/productSchema');
const { collectGlobalSizeIds } = require('../../schemas/variantSchema');

const SIZE_ID = '11111111-1111-4111-8111-111111111111';
const baseProduct = { name: 'Remera', price: 100 };
const sizeVariant = (optionMeta, options = ['M', 'L']) => ({ name: 'Talle', options, optionMeta });
const parseVariants = (variants) => createProductSchema.safeParse({ ...baseProduct, variants });

test('talle: normaliza el nombre a mayúsculas y recorta espacios', () => {
  const result = createSizeSchema.parse({ name: '  xl ', type: 'indumentaria' });
  assert.equal(result.name, 'XL');
});

test('talle: rechaza nombre vacío, de 21 caracteres y tipo desconocido', () => {
  assert.equal(createSizeSchema.safeParse({ name: '   ', type: 'calzado' }).success, false);
  assert.equal(createSizeSchema.safeParse({ name: 'A'.repeat(21), type: 'calzado' }).success, false);
  assert.equal(createSizeSchema.safeParse({ name: 'M', type: 'otro' }).success, false);
});

test('talle: campos extra (mass assignment) se rechazan', () => {
  assert.equal(createSizeSchema.safeParse({ name: 'M', type: 'calzado', id: SIZE_ID }).success, false);
  assert.equal(updateSizeSchema.safeParse({ createdAt: 'x' }).success, false);
});

test('talle: medidas válidas en el límite (8 claves, 30 y 20 caracteres)', () => {
  const measurements = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`k${i}`.padEnd(30, 'x'), 'v'.repeat(20)])
  );
  assert.equal(createSizeSchema.safeParse({ name: 'M', type: 'calzado', measurements }).success, true);
});

test('talle: medidas inválidas (9 claves, clave larga/vacía, valor largo, no string, array)', () => {
  const nineKeys = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v']));
  const invalid = [
    nineKeys, { ['k'.repeat(31)]: 'v' }, { '': 'v' }, { a: 'v'.repeat(21) }, { a: 5 }, { a: null }, ['x'], 'texto', null,
  ];
  for (const measurements of invalid) {
    const result = createSizeSchema.safeParse({ name: 'M', type: 'calzado', measurements });
    assert.equal(result.success, false, JSON.stringify(measurements));
  }
});

test('talle: medidas con __proto__, constructor o prototype se rechazan (JSON.parse crea la clave propia)', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const measurements = JSON.parse(`{"${key}": "x"}`);
    assert.equal(createSizeSchema.safeParse({ name: 'M', type: 'calzado', measurements }).success, false, key);
  }
});

test('talle: update parcial acepta active y vacío (el 400 NO_FIELDS lo da el modelo)', () => {
  assert.deepEqual(updateSizeSchema.parse({ active: false }), { active: false });
  assert.deepEqual(updateSizeSchema.parse({}), {});
  assert.equal(updateSizeSchema.safeParse({ active: 'false' }).success, false);
});

test('variants: sin optionMeta conserva todos los campos existentes tal cual', () => {
  const variant = { name: 'Talle', options: ['M'], stockByOption: { M: 3 }, colorsByOption: { M: ['rojo'] }, extra: 1 };
  const result = parseVariants([variant]);
  assert.equal(result.success, true);
  assert.deepEqual(result.data.variants[0], variant);
});

test('variants: optionMeta global y custom válidos se conservan junto al resto de la variante', () => {
  const variant = {
    ...sizeVariant({
      M: { source: 'global', sizeId: SIZE_ID.toUpperCase() },
      L: { source: 'custom', measurements: { Pecho: '50 cm' } },
    }),
    stockByOption: { M: 2, L: 1 },
  };
  const result = parseVariants([variant]);
  assert.equal(result.success, true);
  const [parsed] = result.data.variants;
  assert.deepEqual(parsed.optionMeta.M, { source: 'global', sizeId: SIZE_ID });
  assert.deepEqual(parsed.optionMeta.L, { source: 'custom', measurements: { Pecho: '50 cm' } });
  assert.deepEqual(parsed.stockByOption, { M: 2, L: 1 });
});

test('variants: global exige sizeId uuid y no admite measurements', () => {
  assert.equal(parseVariants([sizeVariant({ M: { source: 'global' } })]).success, false);
  assert.equal(parseVariants([sizeVariant({ M: { source: 'global', sizeId: 'no-uuid' } })]).success, false);
  assert.equal(parseVariants([sizeVariant({ M: { source: 'global', sizeId: SIZE_ID, measurements: {} } })]).success, false);
});

test('variants: custom no admite sizeId y valida las medidas con los mismos límites', () => {
  assert.equal(parseVariants([sizeVariant({ M: { source: 'custom', sizeId: SIZE_ID } })]).success, false);
  assert.equal(parseVariants([sizeVariant({ M: { source: 'custom', measurements: { a: 'v'.repeat(21) } } })]).success, false);
  assert.equal(parseVariants([sizeVariant({ M: { source: 'custom' } })]).success, true);
});

test('variants: source desconocido, entrada no objeto y campos extra se rechazan', () => {
  assert.equal(parseVariants([sizeVariant({ M: { source: 'otro' } })]).success, false);
  assert.equal(parseVariants([sizeVariant({ M: 'global' })]).success, false);
  assert.equal(parseVariants([sizeVariant({ M: { source: 'custom', admin: true } })]).success, false);
  assert.equal(parseVariants([sizeVariant([])]).success, false);
});

test('variants: las claves de optionMeta deben existir en options (en mayúsculas)', () => {
  assert.equal(parseVariants([sizeVariant({ XL: { source: 'custom' } })]).success, false);
  assert.equal(parseVariants([sizeVariant({ m: { source: 'custom' } })]).success, false);
  assert.equal(parseVariants([sizeVariant({ M: { source: 'custom' } }, ['m'])]).success, true);
});

test('variants: optionMeta con claves maliciosas (__proto__) se rechaza', () => {
  const optionMeta = JSON.parse('{"__proto__": {"source": "custom"}}');
  assert.equal(parseVariants([sizeVariant(optionMeta)]).success, false);
  const measurements = JSON.parse('{"__proto__": "x"}');
  assert.equal(parseVariants([sizeVariant({ M: { source: 'custom', measurements } })]).success, false);
});

test('variants: optionMeta en una variante que no es de talle se rechaza', () => {
  const colorVariant = { name: 'Color', options: ['ROJO'], optionMeta: { ROJO: { source: 'custom' } } };
  assert.equal(parseVariants([colorVariant]).success, false);
});

test('variants: el update parcial también valida optionMeta', () => {
  const body = {
    variants: [sizeVariant({ M: { source: 'global', sizeId: 'x' } })],
    expectedUpdatedAt: '2026-10-26T10:00:00.000Z',
  };
  assert.equal(updateProductSchema.safeParse(body).success, false);
});

test('collectGlobalSizeIds: junta ids únicos de las opciones globales e ignora las custom', () => {
  const variants = [
    sizeVariant({ M: { source: 'global', sizeId: SIZE_ID }, L: { source: 'global', sizeId: SIZE_ID }, XL: { source: 'custom' } }),
    { name: 'Color', options: [] },
  ];
  assert.deepEqual(collectGlobalSizeIds(variants), [SIZE_ID]);
  assert.deepEqual(collectGlobalSizeIds(undefined), []);
});
