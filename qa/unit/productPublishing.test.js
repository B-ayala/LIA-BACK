const test = require('node:test');
const assert = require('node:assert/strict');
const { findMissingForActive, ACTIVE_REQUIREMENT_MESSAGES } = require('../../utils/productPublishing');

const complete = () => ({
  status: 'active',
  category: 'Calzado',
  images: ['https://res.cloudinary.com/demo/image/upload/a.jpg'],
  image_url: 'https://res.cloudinary.com/demo/image/upload/a.jpg',
  variants: [
    { name: 'Color', options: ['Negro'] },
    { name: 'Talle', options: ['36', '37'], stockByOption: { 36: 0, 37: 2 } },
  ],
});

test('un producto activo completo no tiene faltantes', () => {
  assert.equal(findMissingForActive(complete()), null);
});

test('status NULL cuenta como activo (igual que el catálogo)', () => {
  assert.equal(findMissingForActive({ ...complete(), status: null, category: '' }), 'category');
});

test('un borrador (Inactivo) no exige nada más que lo que valida el schema', () => {
  assert.equal(findMissingForActive({ status: 'inactive', category: null, images: null, variants: null }), null);
});

test('categoría vacía o solo espacios', () => {
  assert.equal(findMissingForActive({ ...complete(), category: null }), 'category');
  assert.equal(findMissingForActive({ ...complete(), category: '   ' }), 'category');
});

test('sin foto: images vacío y sin image_url; un producto viejo con solo image_url pasa', () => {
  assert.equal(findMissingForActive({ ...complete(), images: [], image_url: '' }), 'images');
  assert.equal(findMissingForActive({ ...complete(), images: ['  '], image_url: null }), 'images');
  assert.equal(findMissingForActive({ ...complete(), images: null }), null);
});

test('sin color: ni variante Color con opciones ni colores por talle', () => {
  const [, talle] = complete().variants;
  assert.equal(findMissingForActive({ ...complete(), variants: [talle] }), 'color');
  assert.equal(findMissingForActive({ ...complete(), variants: [{ name: 'Color', options: [] }, talle] }), 'color');
  const withColorsBySize = { ...talle, colorsByOption: { 37: ['Rojo'] } };
  assert.equal(findMissingForActive({ ...complete(), variants: [withColorsBySize] }), null);
});

test('sin talle: no hay variante de talle o no tiene opciones', () => {
  const [color] = complete().variants;
  assert.equal(findMissingForActive({ ...complete(), variants: [color] }), 'sizes');
  assert.equal(findMissingForActive({ ...complete(), variants: [color, { name: 'Talle', options: [] }] }), 'sizes');
});

test('con talles pero todos en 0, negativos o sin cargar → falta stock', () => {
  const [color] = complete().variants;
  const sizes = (stockByOption) => [color, { name: 'Talle', options: ['M'], stockByOption }];
  assert.equal(findMissingForActive({ ...complete(), variants: sizes({ M: 0 }) }), 'stock');
  assert.equal(findMissingForActive({ ...complete(), variants: sizes({ M: -5 }) }), 'stock');
  assert.equal(findMissingForActive({ ...complete(), variants: sizes(undefined) }), 'stock');
  assert.equal(findMissingForActive({ ...complete(), variants: sizes({ M: 'abc' }) }), 'stock');
});

test('variants malformado (null, no array, items null) no rompe: se reporta como faltante', () => {
  assert.equal(findMissingForActive({ ...complete(), variants: null }), 'color');
  assert.equal(findMissingForActive({ ...complete(), variants: 'x' }), 'color');
  assert.equal(findMissingForActive({ ...complete(), variants: [null] }), 'color');
});

test('cada faltante tiene un mensaje para el admin', () => {
  for (const key of ['category', 'images', 'color', 'sizes', 'stock']) {
    assert.ok(ACTIVE_REQUIREMENT_MESSAGES[key]);
  }
});
