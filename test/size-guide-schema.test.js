const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { sizeGuideSchema } = require('../schemas/sizeGuideSchema');
const { createProductSchema, updateProductSchema } = require('../schemas/productSchema');

const LEGACY_GUIDE = {
  type: 'indumentaria',
  columns: ['S', 'M'],
  rows: [{ label: 'Busto', values: { S: '86', M: '90' } }],
  columnSources: { M: { sizeId: '11111111-1111-4111-8111-111111111111' } },
};

describe('sizeGuideSchema', () => {
  test('acepta una guía existente sin los bloques nuevos y la conserva intacta', () => {
    const parsed = sizeGuideSchema.parse(LEGACY_GUIDE);
    assert.deepEqual(parsed, LEGACY_GUIDE);
  });

  test('acepta la guía completa con aclaraciones y referencia de calce', () => {
    const guide = {
      ...LEGACY_GUIDE,
      unit: 'cm',
      measurementBasis: 'body',
      notes: ['Las medidas de la tabla corresponden a {medidas}.'],
      fitReferenceMode: 'custom',
      fitReference: {
        modelHeightCm: 170, topSize: 'S', bottomSize: 'M', fit: 'Ajustado',
        image: 'https://res.cloudinary.com/demo/image/upload/a.jpg',
      },
    };
    assert.equal(sizeGuideSchema.safeParse(guide).success, true);
  });

  test('acepta ocultar la modelo y rechaza modos desconocidos', () => {
    assert.equal(sizeGuideSchema.safeParse({ ...LEGACY_GUIDE, fitReferenceMode: 'hidden' }).success, true);
    assert.equal(sizeGuideSchema.safeParse({ ...LEGACY_GUIDE, fitReferenceMode: 'global' }).success, false);
  });

  test('rechaza una base de medidas desconocida', () => {
    assert.equal(sizeGuideSchema.safeParse({ ...LEGACY_GUIDE, measurementBasis: 'aprox' }).success, false);
  });

  test('rechaza alturas de modelo fuera de rango o con decimales', () => {
    for (const modelHeightCm of [99, 231, 170.5, '170']) {
      const result = sizeGuideSchema.safeParse({ ...LEGACY_GUIDE, fitReference: { modelHeightCm } });
      assert.equal(result.success, false, `debería rechazar ${modelHeightCm}`);
    }
  });

  test('rechaza campos desconocidos en la referencia de calce', () => {
    const result = sizeGuideSchema.safeParse({ ...LEGACY_GUIDE, fitReference: { weightKg: 60 } });
    assert.equal(result.success, false);
  });

  test('rechaza imágenes que no son URL y aclaraciones vacías, largas o de más', () => {
    const cases = [
      { fitReference: { image: 'javascript:alert(1)' } },
      { notes: ['   '] },
      { notes: ['x'.repeat(301)] },
      { notes: Array.from({ length: 9 }, (_, i) => `nota ${i}`) },
    ];
    for (const extra of cases) {
      assert.equal(sizeGuideSchema.safeParse({ ...LEGACY_GUIDE, ...extra }).success, false, JSON.stringify(extra));
    }
  });
});

describe('productSchema.sizeGuide', () => {
  const base = { name: 'Remera', price: 100 };

  test('null borra la guía en una edición y se acepta en el alta', () => {
    assert.equal(updateProductSchema.safeParse({ sizeGuide: null }).success, true);
    assert.equal(createProductSchema.safeParse({ ...base, sizeGuide: null }).success, true);
  });

  test('una guía inválida corta el alta del producto', () => {
    const result = createProductSchema.safeParse({ ...base, sizeGuide: { ...LEGACY_GUIDE, unit: 'pulgadas' } });
    assert.equal(result.success, false);
  });
});
