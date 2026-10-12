/**
 * Reserva de stock del checkout (mp-preference y transfer) y su compensación.
 *
 * El trigger `trg_decrement_stock` descuenta al insertar la venta, pero con
 * `GREATEST(stock,0)`, que permitiría sobreventa silenciosa: por eso se valida
 * disponibilidad con la fila bloqueada (`FOR UPDATE`) antes de insertar. El lock
 * se mantiene hasta el COMMIT, así que las líneas posteriores del mismo producto
 * ya ven el stock que descontó el trigger, y dos compras simultáneas del último
 * ítem se serializan (una gana, la otra recibe 409). Los productos se bloquean en
 * orden de id ascendente para que dos carritos no se bloqueen mutuamente.
 */

const crypto = require('crypto');
const Order = require('../models/Order');
const logger = require('../utils/logger');
const { invalidateProducts } = require('../utils/cache');
const { withTransaction, rollbackWith } = require('../utils/transaction');
const { DEDUCT, applySizeDelta } = require('../utils/variantStock');
const {
  CHECKOUT_ERROR, resolveShippingCost, planReservationLines, evaluateLine,
} = require('../utils/checkoutRules');

const HTTP_BAD_REQUEST = 400;
const HTTP_SERVER_ERROR = 500;

/** Valida, inserta y descuenta talle de UNA línea con la fila del producto bloqueada. */
const reserveLine = async (client, line, order) => {
  const product = await Order.getProductForUpdate(client, line.productId);
  const evaluation = evaluateLine(product, line);
  if (!evaluation.ok) return evaluation;

  const { item, index, productId } = line;
  const orderId = await Order.insertPending(client, {
    ...order.buyer,
    productId,
    productName: evaluation.name,
    productImage: evaluation.image,
    quantity: item.quantity,
    unitPrice: evaluation.unitPrice,
    // El costo de envío se suma a la PRIMERA línea del pedido original (mismo criterio que el front).
    totalPrice: evaluation.unitPrice * item.quantity + (index === 0 ? order.surcharge : 0),
    unitsConfig: evaluation.units,
    paymentMethod: order.paymentMethod,
    shippingMethod: order.shippingMethod,
    mpExternalReference: order.purchaseId,
  });
  const nextVariants = applySizeDelta(product.variants, evaluation.units, DEDUCT);
  if (nextVariants) await Order.setVariants(client, productId, nextVariants);

  return {
    ok: true,
    index,
    orderId: String(orderId),
    pricedItem: {
      productName: evaluation.name,
      productImage: evaluation.image,
      quantity: item.quantity,
      unitPrice: evaluation.unitPrice,
    },
  };
};

const reserveLines = async (client, lines, order) => {
  const reserved = new Array(lines.length);
  for (const line of lines) {
    const result = await reserveLine(client, line, order);
    if (!result.ok) return rollbackWith(result);
    reserved[result.index] = result;
  }
  return {
    ok: true,
    orderIds: reserved.map((line) => line.orderId),
    pricedItems: reserved.map((line) => line.pricedItem),
    shippingCost: order.surcharge,
    purchaseId: order.purchaseId,
  };
};

/**
 * Reserva el stock e inserta las ventas pendientes en una única transacción corta.
 * Para Mercado Pago genera el id de compra (`mp_external_reference`) y lo guarda en
 * la MISMA transacción, antes del COMMIT.
 *
 * @returns {Promise<{ok: true, orderIds: string[], pricedItems: object[], shippingCost: number,
 *   purchaseId: string|null} | {ok: false, status: number, code: string, message: string,
 *   productId?: string|null, size?: string}>}
 */
const reserveOrders = async ({ buyerName, buyerEmail, userId, items, shippingMethod, shippingCost, paymentMethod }) => {
  const shipping = resolveShippingCost(shippingMethod, shippingCost);
  if (!shipping.ok) {
    return { ok: false, status: HTTP_BAD_REQUEST, code: CHECKOUT_ERROR.invalidShipping, message: shipping.message };
  }
  const plan = planReservationLines(items);
  if (!plan.ok) return plan.failure;

  const order = {
    buyer: { buyerName, buyerEmail, userId },
    surcharge: shipping.cost,
    paymentMethod,
    shippingMethod,
    purchaseId: paymentMethod === 'mp' ? crypto.randomUUID() : null,
  };
  try {
    const result = await withTransaction(`reserve_orders_${paymentMethod}`, (client) => reserveLines(client, plan.lines, order));
    if (result.ok) invalidateProducts();
    return result;
  } catch (error) {
    logger.error('order_reserve_failed', { paymentMethod, code: error.code, message: error.message });
    return {
      ok: false,
      status: HTTP_SERVER_ERROR,
      code: 'ORDER_RESERVE_FAILED',
      message: 'No se pudo registrar la orden. Intentá de nuevo.',
    };
  }
};

/**
 * Compensación: cancela reservas recién creadas y devuelve su stock. Se usa cuando
 * la reserva salió bien pero el paso siguiente falló (ej. MP no devolvió
 * preferencia). No propaga errores: el sweep de órdenes vencidas (cada 60 s) es la
 * red de seguridad si esta compensación falla.
 */
const releaseOrders = async (orderIds) => {
  try {
    const released = await withTransaction('release_orders', async (client) => {
      const rows = await Order.findByIdsForUpdate(client, orderIds);
      return Order.cancelLockedPending(client, rows);
    });
    if (released > 0) invalidateProducts();
  } catch (error) {
    logger.error('order_release_failed', { orderIds, code: error.code, message: error.message });
  }
};

module.exports = { reserveOrders, releaseOrders };
