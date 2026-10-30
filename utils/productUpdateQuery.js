/**
 * Arma el UPDATE parcial de un producto (puro, testeable).
 *
 * - Solo se tocan las columnas cuyos campos vienen en el body: si no viene `stock`,
 *   la columna `stock` no se escribe (el front la omite cuando el stock lo maneja la
 *   venta, y reescribirla con un valor leído antes pisaría lo que descontó una compra).
 * - `expectedUpdatedAt` (control optimista): si viene, el UPDATE solo aplica si
 *   `updated_at` sigue siendo el que leyó el cliente, comparado en SQL dentro del
 *   mismo UPDATE (atómico, sin ventana entre leer y escribir).
 * Los nombres de columna salen de esta tabla fija, nunca del input.
 */

const toJson = (value) => JSON.stringify(value);
const toJsonOrNull = (value) => (value ? JSON.stringify(value) : null);
const toFloat = (value) => Number.parseFloat(value);
const toFloatOrNull = (value) => (value ? Number.parseFloat(value) : null);
const identity = (value) => value;

const FIELD_COLUMNS = [
  ['name', 'name', identity],
  ['price', 'price', toFloat],
  ['stock', 'stock', identity],
  ['category', 'category', identity],
  ['publicId', 'public_id', identity],
  ['description', 'description', identity],
  ['discount', 'discount', toFloatOrNull],
  ['transferPrice', 'transfer_price', toFloatOrNull],
  ['condition', 'condition', identity],
  ['freeShipping', 'free_shipping', identity],
  ['hoverImageEnabled', 'hover_image_enabled', identity],
  ['variants', 'variants', toJson],
  ['specifications', 'specifications', toJson],
  ['features', 'features', toJson],
  ['faqs', 'faqs', toJson],
  ['warranty', 'warranty', identity],
  ['returnPolicy', 'return_policy', identity],
  ['sizeGuide', 'size_guide', toJsonOrNull],
  ['cardOptions', 'card_options', toJsonOrNull],
  ['status', 'status', identity],
];

/**
 * `price` es siempre el precio FINAL (lo que se cobra: ver resolveUnitPrice en
 * checkoutRules); `original_price` es solo el precio de lista tachado. Un tachado
 * que no supere al final no es una promo válida, así que se descarta.
 */
const resolveOriginalPrice = (originalPrice, price) => {
  const original = Number.parseFloat(originalPrice);
  if (!Number.isFinite(original) || original <= 0) return null;
  const finalPrice = Number.parseFloat(price);
  if (Number.isFinite(finalPrice) && original <= finalPrice) return null;
  return original;
};

/** `image_url` acompaña a la primera imagen de `images` (o a `imageUrl` si no hay). */
const imageAssignments = ({ images, imageUrl }) => {
  if (images !== undefined) {
    const firstImage = images && images.length > 0 ? images[0] : (imageUrl || '');
    return [['images', JSON.stringify(images)], ['image_url', firstImage]];
  }
  return imageUrl !== undefined ? [['image_url', imageUrl]] : [];
};

/** `originalPrice: null` lo borra; se valida contra el `price` del mismo body (si viene). */
const originalPriceAssignments = ({ originalPrice, price }) =>
  originalPrice !== undefined ? [['original_price', resolveOriginalPrice(originalPrice, price)]] : [];

/** @returns {Array<[string, unknown]>} pares columna → valor de los campos presentes. */
const buildProductAssignments = (body) => [
  ...FIELD_COLUMNS
    .filter(([field]) => body[field] !== undefined)
    .map(([field, column, convert]) => [column, convert(body[field])]),
  ...originalPriceAssignments(body),
  ...imageAssignments(body),
];

/** @returns {{text: string, values: unknown[]}} */
const buildProductUpdateStatement = (id, assignments, expectedUpdatedAt) => {
  const values = assignments.map(([, value]) => value);
  const sets = assignments.map(([column], index) => `${column} = $${index + 1}`);
  values.push(id);
  let where = `id = $${values.length}`;
  if (expectedUpdatedAt) {
    values.push(expectedUpdatedAt);
    where += ` AND updated_at = $${values.length}::timestamptz`;
  }
  return {
    text: `UPDATE public.productos SET ${sets.join(', ')}, updated_at = NOW() WHERE ${where} RETURNING *`,
    values,
  };
};

module.exports = { buildProductAssignments, buildProductUpdateStatement, resolveOriginalPrice };
