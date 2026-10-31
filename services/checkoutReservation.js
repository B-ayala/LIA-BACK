/**
 * Reserva de stock del checkout (mp-preference y transfer) y su compensación.
 *
 * El trigger `trg_decrement_stock` descuenta al insertar la venta; si el stock no
 * alcanzara, el CHECK `stock >= 0` aborta el INSERT. Por eso se valida
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
  CHECKOUT_ERROR, resolveShippingCost, planReservationLines, evaluateLine, checkExpectedTotal, roundToCents,
} = require('../utils/checkoutRules');

const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

// Un producto muy disputado hace cola por su lock; esperar más que esto retiene una
// conexión del pool sin beneficio (el statement_timeout general es de 10 s).
const DEFAULT_RESERVE_LOCK_TIMEOUT_MS = 3000;
const PG_LOCK_NOT_AVAILABLE = '55P03';
const ORDER_BUSY_MESSAGE = 'Hay mucha demanda sobre este producto. Intentá de nuevo en unos segundos.';

const parseLockTimeoutMs = () => {
  const configured = Number.parseInt(process.env.RESERVE_LOCK_TIMEOUT_MS, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RESERVE_LOCK_TIMEOUT_MS;
};
const RESERVE_LOCK_TIMEOUT_MS = parseLockTimeoutMs();

// Cuánto stock puede retener una sola cuenta sin pagar: sin tope, un script con una
// cuenta barata vacía el catálogo a fuerza de reservas hasta que vencen (15 min).
const DEFAULT_MAX_PENDING_LINES_PER_USER = 30;
// Y cuántas UNIDADES: el tope por líneas solo no alcanza (una línea puede llevar muchas unidades).
const DEFAULT_MAX_PENDING_UNITS_PER_USER = 60;
const TOO_MANY_PENDING_CODE = 'TOO_MANY_PENDING_ORDERS';
const TOO_MANY_PENDING_MESSAGE = 'Tenés compras pendientes de pago. Pagalas o cancelalas antes de iniciar otra.';

const maxPendingLinesPerUser = () => {
  const configured = Number.parseInt(process.env.MAX_PENDING_LINES_PER_USER, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PENDING_LINES_PER_USER;
};

const maxPendingUnitsPerUser = () => {
  const configured = Number.parseInt(process.env.MAX_PENDING_UNITS_PER_USER, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PENDING_UNITS_PER_USER;
};

const sumUnits = (lines) => lines.reduce((total, line) => total + line.item.quantity, 0);

/** @returns {Promise<object|null>} el fallo a devolver, o null si el usuario puede reservar más. */
const checkPendingLimit = async (client, userId, newLines) => {
  const pending = await Order.countPendingByUser(client, userId);
  const withinLines = pending.lines + newLines.length <= maxPendingLinesPerUser();
  const withinUnits = pending.units + sumUnits(newLines) <= maxPendingUnitsPerUser();
  if (withinLines && withinUnits) return null;
  logger.warn('order_blocked_too_many_pending', { userId, pendingLines: pending.lines, pendingUnits: pending.units });
  return {
    ok: false, status: HTTP_TOO_MANY_REQUESTS, code: TOO_MANY_PENDING_CODE, message: TOO_MANY_PENDING_MESSAGE,
  };
};

/** Valida, inserta y descuenta talle de UNA línea con la fila del producto bloqueada. */
const reserveLine = async (client, line, order) => {
  const product = await Order.getProductForUpdate(client, line.productId);
  const evaluation = evaluateLine(product, line, order.paymentMethod);
  if (!evaluation.ok) return evaluation;

  const { item, index, productId } = line;
  const itemsTotal = roundToCents(evaluation.unitPrice * item.quantity);
  const orderId = await Order.insertPending(client, {
    ...order.buyer,
    productId,
    productName: evaluation.name,
    productImage: evaluation.image,
    quantity: item.quantity,
    unitPrice: evaluation.unitPrice,
    // El costo de envío se suma a la PRIMERA línea del pedido original (mismo criterio que el front).
    totalPrice: itemsTotal + (index === 0 ? order.surcharge : 0),
    unitsConfig: evaluation.units,
    paymentMethod: order.paymentMethod,
    shippingMethod: order.shippingMethod,
    mpExternalReference: order.purchaseId,
    orderNumber: order.orderNumber,
  });
  const nextVariants = applySizeDelta(product.variants, evaluation.units, DEDUCT);
  if (nextVariants) await Order.setVariants(client, productId, nextVariants);

  return {
    ok: true,
    index,
    orderId: String(orderId),
    itemsTotal,
    pricedItem: {
      productName: evaluation.name,
      productImage: evaluation.image,
      quantity: item.quantity,
      unitPrice: evaluation.unitPrice,
    },
  };
};

const reserveLines = async (client, lines, order) => {
  const blocked = await checkPendingLimit(client, order.buyer.userId, lines);
  if (blocked) return rollbackWith(blocked);

  // Un número por checkout: todas las líneas del carrito lo comparten. Se pide dentro de la
  // transacción; si se hace rollback queda un hueco en la secuencia, que es inocuo.
  const numbered = { ...order, orderNumber: await Order.nextOrderNumber(client) };
  const reserved = new Array(lines.length);
  for (const line of lines) {
    const result = await reserveLine(client, line, numbered);
    if (!result.ok) return rollbackWith(result);
    reserved[result.index] = result;
  }
  const chargedTotal = roundToCents(reserved.reduce((sum, line) => sum + line.itemsTotal, 0) + order.surcharge);
  const priceChanged = checkExpectedTotal(order.expectedTotal, chargedTotal);
  if (priceChanged) {
    logger.info('order_rejected_price_changed', { paymentMethod: order.paymentMethod, chargedTotal });
    return rollbackWith(priceChanged);
  }
  return {
    ok: true,
    orderIds: reserved.map((line) => line.orderId),
    pricedItems: reserved.map((line) => line.pricedItem),
    shippingCost: order.surcharge,
    purchaseId: order.purchaseId,
    orderNumber: numbered.orderNumber,
  };
};

/**
 * Reserva el stock e inserta las ventas pendientes en una única transacción corta.
 * Para Mercado Pago genera el id de compra (`mp_external_reference`) y lo guarda en
 * la MISMA transacción, antes del COMMIT.
 *
 * @returns {Promise<{ok: true, orderIds: string[], pricedItems: object[], shippingCost: number,
 *   purchaseId: string|null, orderNumber: number} | {ok: false, status: number, code: string, message: string,
 *   productId?: string|null, size?: string}>}
 */
const reserveOrders = async ({
  buyerName, buyerEmail, userId, items, shippingMethod, shippingCost, paymentMethod, expectedTotal,
}) => {
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
    expectedTotal,
    purchaseId: paymentMethod === 'mp' ? crypto.randomUUID() : null,
  };
  try {
    const result = await withTransaction(
      `reserve_orders_${paymentMethod}`,
      (client) => reserveLines(client, plan.lines, order),
      { lockTimeoutMs: RESERVE_LOCK_TIMEOUT_MS }
    );
    if (result.ok) invalidateProducts();
    return result;
  } catch (error) {
    if (error.code === PG_LOCK_NOT_AVAILABLE) {
      logger.warn('order_reserve_lock_timeout', { paymentMethod });
      return { ok: false, status: HTTP_SERVICE_UNAVAILABLE, code: 'ORDER_BUSY', message: ORDER_BUSY_MESSAGE };
    }
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
