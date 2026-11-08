const { z } = require('zod');
const { isValidEmail, MAX_EMAIL_LENGTH } = require('../utils/emailValidation');
const { maxQuantityPerLine } = require('../utils/checkoutRules');

/**
 * Contrato del body de `POST /api/orders/transfer` y `/mp-preference`, validado en el borde
 * ANTES de tomar cualquier lock de producto. `strictObject` rechaza claves desconocidas.
 * `unitPrice`/`totalPrice` por línea el servidor los ignora (cobra el precio de la base), pero
 * se exigen bien formados: es el contrato que ya cumple el frontend.
 * El método de envío se valida contra la whitelist en `resolveShippingCost`.
 */

const MAX_ORDER_ITEMS = 50;
const MAX_BUYER_NAME_LENGTH = 120;
const MAX_PRODUCT_NAME_LENGTH = 300;
const MAX_URL_LENGTH = 2048;
const MAX_ID_LENGTH = 64;
const MAX_SHIPPING_METHOD_LENGTH = 32;
const MAX_UNITS_PER_LINE = 100;
const MAX_VARIANT_KEYS = 20;
const MAX_VARIANT_KEY_LENGTH = 60;
const MAX_VARIANT_VALUE_LENGTH = 100;

const GENERIC_MESSAGE = 'Los datos de la compra no son válidos.';

const UNITS_MESSAGE = 'Las opciones elegidas no son válidas (unitsConfig).';

const text = (message) => z.string({ error: message });
const finiteNumber = (message) => z.number({ error: message }).finite(message);

const unitVariantsSchema = z.record(
  z.string().max(MAX_VARIANT_KEY_LENGTH, UNITS_MESSAGE),
  z.union([z.string().max(MAX_VARIANT_VALUE_LENGTH), z.number().finite()], { error: UNITS_MESSAGE }),
  { error: UNITS_MESSAGE }
).refine((unit) => Object.keys(unit).length <= MAX_VARIANT_KEYS, UNITS_MESSAGE);

const productIdSchema = z.union([
  z.string().max(MAX_ID_LENGTH),
  z.number().finite(),
], { error: 'No se pudo identificar el producto (productId).' });

const itemSchema = z.strictObject({
  productId: productIdSchema,
  productName: text('Los datos del producto son inválidos (productName).').trim()
    .min(1, 'Los datos del producto son inválidos (productName).')
    .max(MAX_PRODUCT_NAME_LENGTH, 'Los datos del producto son inválidos (productName).'),
  productImage: z.string().max(MAX_URL_LENGTH).nullish(),
  quantity: z.number({ error: 'La cantidad seleccionada es inválida (quantity).' })
    .int('La cantidad seleccionada es inválida (quantity).')
    .positive('La cantidad seleccionada es inválida (quantity).'),
  unitPrice: finiteNumber('El producto no tiene un precio válido (unitPrice).')
    .positive('El producto no tiene un precio válido (unitPrice).'),
  totalPrice: finiteNumber('El total calculado del producto es inválido (totalPrice).')
    .positive('El total calculado del producto es inválido (totalPrice).'),
  unitsConfig: z.array(unitVariantsSchema, { error: UNITS_MESSAGE })
    .max(MAX_UNITS_PER_LINE, UNITS_MESSAGE).optional(),
}, { error: 'Los datos del producto son inválidos (productName).' }).superRefine((item, ctx) => {
  const limit = maxQuantityPerLine();
  if (item.quantity > limit) {
    ctx.addIssue({
      code: 'custom',
      path: ['quantity'],
      message: `Podés comprar hasta ${limit} unidades de "${item.productName}" por compra.`,
    });
  }
});

const checkoutBodySchema = z.strictObject({
  buyerName: text('El nombre del comprador es requerido.').trim()
    .min(1, 'El nombre del comprador es requerido.')
    .max(MAX_BUYER_NAME_LENGTH, `El nombre del comprador no puede superar ${MAX_BUYER_NAME_LENGTH} caracteres.`),
  buyerEmail: text('El email del comprador no es válido.')
    .max(MAX_EMAIL_LENGTH, 'El email del comprador no es válido.')
    .refine(isValidEmail, 'El email del comprador no es válido.'),
  items: z.array(itemSchema, { error: 'No hay productos en el carrito para procesar la compra.' })
    .min(1, 'No hay productos en el carrito para procesar la compra.')
    .max(MAX_ORDER_ITEMS, `El carrito supera el máximo de ${MAX_ORDER_ITEMS} productos por compra.`),
  shippingMethod: z.string({ error: 'El método de envío seleccionado no es válido.' })
    .max(MAX_SHIPPING_METHOD_LENGTH, 'El método de envío seleccionado no es válido.').optional(),
  // El costo lo fija el servidor; se acepta por compatibilidad con el frontend y se ignora.
  shippingCost: z.number({ error: 'El costo de envío informado no es válido.' }).finite().nullish(),
  totalPrice: finiteNumber('El total final es inválido (totalPrice).').positive('El total final es inválido (totalPrice).'),
}, { error: GENERIC_MESSAGE });

/** Mensaje humano de un issue de zod (las claves desconocidas no se enumeran al cliente). */
const issueMessage = (issue) => (issue.code === 'unrecognized_keys' ? GENERIC_MESSAGE : issue.message);

/**
 * @returns {{ok: true, data: object} | {ok: false, message: string, details: {field: string, message: string}[]}}
 */
const parseCheckoutBody = (body) => {
  const result = checkoutBodySchema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    message: issueMessage(result.error.issues[0]),
    details: result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'body',
      message: issueMessage(issue),
    })),
  };
};

module.exports = { checkoutBodySchema, parseCheckoutBody };
