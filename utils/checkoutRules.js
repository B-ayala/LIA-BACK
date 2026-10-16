/**
 * Reglas de negocio puras del checkout: validación del pedido, precio, envío,
 * orden de bloqueo y disponibilidad de cada línea contra la fila del producto.
 * Sin I/O: la transacción que las usa vive en services/checkoutReservation.js.
 */

const { CORREO_COST } = require('../controllers/shippingController');
const { REASON, validateSizeStock } = require('./variantStock');
const { UNITS_PROBLEM, validateUnitsConfig } = require('./unitsConfig');

const MAX_ORDER_ITEMS = 50;
// Tope de unidades de un mismo producto por línea: sin él, una sola línea podía reservar
// todo el stock de un producto (5 h en transferencia) sin pagar nada.
const DEFAULT_MAX_QUANTITY_PER_LINE = 20;
const MAX_MOTO_SHIPPING_COST = 100000;
// Se persisten tal cual en `ventas`: se acotan para no guardar texto arbitrario.
const MAX_BUYER_NAME_LENGTH = 120;
const MAX_BUYER_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 18 dígitos entran siempre en un bigint de Postgres (el máximo tiene 19).
const PRODUCT_ID_PATTERN = /^\d{1,18}$/;

const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;

// Costo de envío por método. `moto` es variable (se acuerda por WhatsApp según
// distancia), así que solo se acota; el resto es una constante del negocio y se
// impone desde acá: el cliente no puede elegir cuánto paga de envío.
const SHIPPING_COSTS = { local: 0, correo: CORREO_COST };

const CHECKOUT_ERROR = Object.freeze({
  outOfStock: 'OUT_OF_STOCK',
  sizeOutOfStock: 'SIZE_OUT_OF_STOCK',
  sizeUnavailable: UNITS_PROBLEM.sizeUnavailable,
  sizeRequired: UNITS_PROBLEM.sizeRequired,
  invalidVariant: UNITS_PROBLEM.invalidVariant,
  invalidProductId: 'INVALID_PRODUCT_ID',
  productUnavailable: 'PRODUCT_UNAVAILABLE',
  invalidShipping: 'INVALID_SHIPPING',
});

/**
 * Precio unitario vigente de un producto, calculado desde la fila de la base.
 * Replica `getProductPricing` del frontend (`src/utils/pricing.ts`) para cobrar
 * lo mismo que el usuario vio, pero decidido por el servidor. Si las reglas de
 * precio cambian, deben cambiar en los dos lados.
 */
const resolveUnitPrice = ({ price, discount, original_price: originalPrice }) => {
  const basePrice = Number(price) || 0;
  const promoOriginal = Number(originalPrice);
  // Promoción ya aplicada en `price`: `original_price` es solo el precio tachado.
  if (Number.isFinite(promoOriginal) && promoOriginal > basePrice) return basePrice;

  const safeDiscount = Number(discount);
  if (Number.isFinite(safeDiscount) && safeDiscount > 0) {
    return basePrice * (1 - safeDiscount / 100);
  }
  return basePrice;
};

/** @returns {{ok: true, cost: number} | {ok: false, message: string}} */
const resolveShippingCost = (shippingMethod, rawCost) => {
  const requested = Number.isFinite(Number(rawCost)) ? Number(rawCost) : 0;
  if (shippingMethod === 'moto') {
    if (requested < 0 || requested > MAX_MOTO_SHIPPING_COST) {
      return { ok: false, message: 'El costo de envío informado no es válido.' };
    }
    return { ok: true, cost: requested };
  }
  const official = SHIPPING_COSTS[shippingMethod];
  if (official === undefined) {
    return { ok: false, message: 'El método de envío seleccionado no es válido.' };
  }
  return { ok: true, cost: official };
};

/** Unidades máximas por línea (`MAX_QUANTITY_PER_LINE`, por defecto 20). */
const maxQuantityPerLine = () => {
  const configured = Number.parseInt(process.env.MAX_QUANTITY_PER_LINE, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_QUANTITY_PER_LINE;
};

const validateItem = (item) => {
  if (!item || !item.productName || !String(item.productName).trim()) {
    return 'Los datos del producto son inválidos (productName).';
  }
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
    return `La cantidad seleccionada de "${item.productName}" es inválida (quantity).`;
  }
  if (item.quantity > maxQuantityPerLine()) {
    return `Podés comprar hasta ${maxQuantityPerLine()} unidades de "${item.productName}" por compra.`;
  }
  if (!Number.isFinite(item.unitPrice) || item.unitPrice <= 0) {
    return `El producto "${item.productName}" no tiene un precio válido (unitPrice).`;
  }
  if (!Number.isFinite(item.totalPrice) || item.totalPrice <= 0) {
    return `El total calculado de "${item.productName}" es inválido (totalPrice).`;
  }
  return null;
};

/** Valida el payload de creación de orden. Devuelve un mensaje de error o null. */
const validateOrderPayload = ({ buyerName, buyerEmail, items, totalPrice }) => {
  if (!buyerName || !String(buyerName).trim()) return 'El nombre del comprador es requerido.';
  if (String(buyerName).trim().length > MAX_BUYER_NAME_LENGTH) {
    return `El nombre del comprador no puede superar ${MAX_BUYER_NAME_LENGTH} caracteres.`;
  }
  if (!buyerEmail || String(buyerEmail).length > MAX_BUYER_EMAIL_LENGTH || !EMAIL_PATTERN.test(String(buyerEmail))) {
    return 'El email del comprador no es válido.';
  }
  if (!Array.isArray(items) || items.length === 0) {
    return 'No hay productos en el carrito para procesar la compra.';
  }
  // Cota dura: cada ítem es un bloqueo de fila dentro de la transacción.
  if (items.length > MAX_ORDER_ITEMS) {
    return `El carrito supera el máximo de ${MAX_ORDER_ITEMS} productos por compra.`;
  }
  for (const item of items) {
    const itemError = validateItem(item);
    if (itemError) return itemError;
  }
  if (!Number.isFinite(totalPrice) || totalPrice <= 0) return 'El total final es inválido (totalPrice).';
  return null;
};

const parseProductId = (raw) => {
  const value = typeof raw === 'number' ? String(raw) : raw;
  return typeof value === 'string' && PRODUCT_ID_PATTERN.test(value) ? value : null;
};

const compareProductIds = (a, b) => {
  const left = BigInt(a);
  const right = BigInt(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

/**
 * Líneas del pedido en el orden en que se bloquean los productos: `productId`
 * ascendente. Dos carritos con los mismos productos en distinto orden ya no
 * pueden bloquearse mutuamente (deadlock). `index` conserva la posición original
 * (el recargo de envío va en la PRIMERA línea del pedido, no del orden de bloqueo).
 * @returns {{ok: true, lines: object[]} | {ok: false, failure: object}}
 */
const planReservationLines = (items) => {
  const lines = items.map((item, index) => ({ item, index, productId: parseProductId(item.productId) }));
  const invalid = lines.find((line) => line.productId === null);
  if (invalid) {
    const rawId = invalid.item.productId;
    const echoedId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).slice(0, 64) : null;
    return {
      ok: false,
      failure: lineFailure(HTTP_BAD_REQUEST, CHECKOUT_ERROR.invalidProductId,
        `No se pudo identificar el producto "${invalid.item.productName}".`, echoedId),
    };
  }
  const sorted = [...lines].sort((a, b) => compareProductIds(a.productId, b.productId) || a.index - b.index);
  return { ok: true, lines: sorted };
};

function lineFailure(status, code, message, productId, size) {
  return {
    ok: false, status, code, message,
    productId: productId == null ? null : String(productId),
    ...(size ? { size } : {}),
  };
}

const UNITS_FAILURES = {
  [UNITS_PROBLEM.sizeRequired]: (name) =>
    [HTTP_BAD_REQUEST, `Elegí el talle de cada unidad de "${name}".`],
  [UNITS_PROBLEM.sizeUnavailable]: (name, problem) =>
    [HTTP_CONFLICT, `El talle ${problem.size} de "${name}" ya no está disponible.`],
  [UNITS_PROBLEM.invalidVariant]: (name, problem) =>
    [HTTP_BAD_REQUEST, problem.variant
      ? `Elegí una opción válida de ${problem.variant} para cada unidad de "${name}".`
      : `Elegí las opciones de cada unidad de "${name}".`],
};

const SIZE_STOCK_FAILURES = {
  [REASON.missingSize]: (name) =>
    [HTTP_BAD_REQUEST, CHECKOUT_ERROR.sizeRequired, `Elegí el talle de cada unidad de "${name}".`],
  [REASON.unknownSize]: (name, size) =>
    [HTTP_CONFLICT, CHECKOUT_ERROR.sizeUnavailable, `El talle ${size} de "${name}" ya no está disponible.`],
  [REASON.noStockForSize]: (name, size) =>
    [HTTP_CONFLICT, CHECKOUT_ERROR.sizeOutOfStock, `No hay stock suficiente del talle ${size} de "${name}".`],
};

const isActiveProduct = (product) => (product.status ?? 'active') === 'active';

const outOfStock = (name, productId) =>
  lineFailure(HTTP_CONFLICT, CHECKOUT_ERROR.outOfStock, `No hay stock suficiente de "${name}".`, productId);

/**
 * Decide si una línea se puede vender con la fila del producto ya bloqueada.
 * Nombre, imagen y precio salen SIEMPRE de la base, nunca del body.
 * @returns {{ok: true, name: string, image: string|null, unitPrice: number, units: object[]}
 *   | {ok: false, status: number, code: string, message: string, productId: string, size?: string}}
 */
const evaluateLine = (product, { item, productId }) => {
  if (!product) return outOfStock(item.productName, productId);
  const name = product.name || item.productName;

  // Un producto dado de baja no se vende aunque el cliente conozca su id: el
  // catálogo no lo muestra, pero la API de checkout es otra puerta. `status` NULL
  // cuenta como activo (mismo criterio que el catálogo).
  if (!isActiveProduct(product)) {
    return lineFailure(HTTP_CONFLICT, CHECKOUT_ERROR.productUnavailable,
      `El producto "${name}" no está disponible para la venta.`, productId);
  }

  // stock NULL se rechaza a propósito (conservador): el trigger hace
  // GREATEST(stock - n, 0) y convertiría "sin control" en 0 sin avisar, y el pago
  // tardío no podría decidir si hay mercadería. Mismo criterio en redeductForLatePayment.
  if (product.stock === null || Number(product.stock) < item.quantity) return outOfStock(name, productId);

  const units = validateUnitsConfig(product.variants, item.unitsConfig, item.quantity);
  if (!units.ok) {
    const [status, message] = UNITS_FAILURES[units.code](name, units);
    return lineFailure(status, units.code, message, productId, units.size);
  }

  const sizeCheck = validateSizeStock(product.variants, units.units, item.quantity);
  if (!sizeCheck.ok) {
    const [status, code, message] = SIZE_STOCK_FAILURES[sizeCheck.reason](name, sizeCheck.size);
    return lineFailure(status, code, message, productId, sizeCheck.size);
  }

  const unitPrice = resolveUnitPrice(product);
  if (!(unitPrice > 0)) {
    return lineFailure(HTTP_CONFLICT, CHECKOUT_ERROR.productUnavailable,
      `El producto "${name}" no está disponible para la venta.`, productId);
  }
  return { ok: true, name, image: product.image || null, unitPrice, units: units.units };
};

module.exports = {
  CHECKOUT_ERROR,
  resolveUnitPrice,
  resolveShippingCost,
  validateOrderPayload,
  maxQuantityPerLine,
  parseProductId,
  planReservationLines,
  evaluateLine,
  lineFailure,
};
