/**
 * Requisitos para publicar un producto (estado "Activo"), sobre una fila de `public.productos`.
 *
 * "Activo" lo ve el cliente: tiene que estar completo. "Inactivo" es un borrador y solo exige
 * nombre y precio (eso ya lo valida el schema). `status` NULL cuenta como activo, igual que en
 * el catálogo. Misma regla en el front (ProductModal/productActiveRequirements.ts).
 */

const { isSizeVariantName } = require('./variantStock');

const INACTIVE_STATUS = 'inactive';
const COLOR_VARIANT_NAME = 'color';

const ACTIVE_REQUIREMENT_MESSAGES = {
  category: 'Elegí una categoría: es obligatoria para un producto Activo.',
  images: 'Agregá al menos una foto: es obligatoria para un producto Activo.',
  color: 'Elegí al menos un color: es obligatorio para un producto Activo.',
  sizes: 'Agregá al menos un talle: es obligatorio para un producto Activo.',
  stock: 'Cargá el stock de al menos un talle: es obligatorio para un producto Activo.',
};

const isFilledText = (value) => typeof value === 'string' && value.trim() !== '';
const asArray = (value) => (Array.isArray(value) ? value : []);
const optionsOf = (variant) => asArray(variant && variant.options);

const hasImage = (row) => asArray(row.images).some(isFilledText) || isFilledText(row.image_url);

const hasColor = (variants) =>
  variants.some((variant) =>
    variant && String(variant.name || '').trim().toLowerCase() === COLOR_VARIANT_NAME && optionsOf(variant).length > 0)
  || variants.some((variant) =>
    Object.values((variant && variant.colorsByOption) || {}).some((colors) => asArray(colors).length > 0));

const findSizeVariant = (variants) =>
  variants.find((variant) => variant && isSizeVariantName(variant.name) && optionsOf(variant).length > 0);

const totalSizeStock = (variant) =>
  Object.values(variant.stockByOption || {}).reduce((sum, units) => sum + Math.max(0, Number(units) || 0), 0);

/**
 * @param {object} row fila de `public.productos` (variants e images ya parseados desde jsonb)
 * @returns {'category'|'images'|'color'|'sizes'|'stock'|null} primer requisito que falta, o null
 */
const findMissingForActive = (row) => {
  if (row.status === INACTIVE_STATUS) return null;
  if (!isFilledText(row.category)) return 'category';
  if (!hasImage(row)) return 'images';
  const variants = asArray(row.variants);
  if (!hasColor(variants)) return 'color';
  const sizeVariant = findSizeVariant(variants);
  if (!sizeVariant) return 'sizes';
  if (totalSizeStock(sizeVariant) <= 0) return 'stock';
  return null;
};

module.exports = { findMissingForActive, ACTIVE_REQUIREMENT_MESSAGES };
