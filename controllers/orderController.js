const crypto = require('crypto');
const { pool } = require('../config/database');
const Order = require('../models/Order');
const User = require('../models/User');
const mercadopago = require('../utils/mercadopago');
const { CORREO_COST } = require('./shippingController');
const { caches, invalidateProducts } = require('../utils/cache');
const logger = require('../utils/logger');
const { orderFingerprint } = require('../utils/orderFingerprint');
const {
  validateBuyerLengths,
  validateUnitsConfig,
  isValidPaymentId,
  isSettleablePayment,
} = require('../utils/orderInput');

// Ventanas de expiración — deben coincidir con las que muestra el frontend
// (MP_EXPIRY_MS / TRANSFER_EXPIRY_MS en admin/pages/Sales).
const MP_EXPIRY_MINUTES = 15;
const TRANSFER_EXPIRY_HOURS = 5;

const MP_NOT_CONFIGURED_MESSAGE =
  'Los pagos con Mercado Pago no están disponibles en este momento. Podés pagar por transferencia.';

// Mensaje mostrado cuando el admin activó el modo de compra restringida
// (ver User.getPurchasePermission) y el usuario actual no está en la lista
// de compradores habilitados.
const PURCHASES_DISABLED_MESSAGE =
  'Por el momento no es posible comprar. Sitio en mantenimiento, gracias por tu paciencia.';

/**
 * Corta el checkout temprano si el modo de compra restringida está activo y
 * este usuario no es uno de los compradores habilitados.
 * @returns {Promise<boolean>} true si ya se respondió la request (bloqueado).
 */
const blockIfPurchaseNotAllowed = async (req, res) => {
  const { allowed } = await User.getPurchasePermission(req.user.id);
  if (allowed) return false;

  logger.warn('order_blocked_purchases_disabled', { userId: req.user.id });
  res.status(403).json({
    success: false,
    code: 'PURCHASES_DISABLED',
    message: PURCHASES_DISABLED_MESSAGE,
  });
  return true;
};

// Respuestas del nudge "¿al final comprás?" (checkout transferencia) → valor de
// `origin` en ventas. 'abandonado' además cancela la orden y devuelve el stock.
const NUDGE_ORIGIN = {
  confirmado: 'wa_confirmado',
  sin_confirmar: 'wa_sin_confirmar',
  abandonado: 'wa_abandonado',
};
const MAX_NUDGE_ORDERS = 50;

const MAX_ORDER_ITEMS = 50;

// Tope de líneas pendientes (stock reservado sin pagar) por usuario: sin él, una sola
// cuenta podría retener el stock de todo el catálogo repitiendo reservas que recién
// vencen a los 15 min (MP) o 5 h (transferencia).
const DEFAULT_MAX_PENDING_LINES_PER_USER = 30;
const maxPendingLinesPerUser = () => {
  const configured = Number.parseInt(process.env.MAX_PENDING_LINES_PER_USER, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_PENDING_LINES_PER_USER;
};
const TOO_MANY_PENDING_MESSAGE =
  'Tenés compras pendientes de pago. Pagalas o cancelalas antes de iniciar otra.';
const TOO_MANY_PENDING_CODE = 'TOO_MANY_PENDING_ORDERS';
const DEFAULT_ORDER_PAGE_SIZE = 200;
const MAX_ORDER_PAGE_SIZE = 500;

// Costo de envío por método. `moto` es variable (se acuerda por WhatsApp según
// distancia), así que solo se acota; el resto es una constante del negocio y se
// impone desde acá: el cliente no puede elegir cuánto paga de envío.
const SHIPPING_COSTS = {
  local: 0,
  correo: CORREO_COST,
};
const MAX_MOTO_SHIPPING_COST = 100000;

// Diferencia máxima tolerada entre lo acreditado en MP y el total de las
// órdenes: absorbe redondeos de centavos sin dejar pasar un pago menor.
const PAYMENT_AMOUNT_TOLERANCE = 1;

/**
 * Precio unitario vigente de un producto, calculado desde la fila de la base.
 *
 * Replica exactamente `getProductPricing` del frontend (`src/utils/pricing.ts`)
 * para que el importe cobrado sea el mismo que el usuario vio en pantalla, pero
 * decidido por el servidor. Si las reglas de precio cambian, deben cambiar en
 * los dos lados.
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

/**
 * Costo de envío validado contra la tarifa del servidor.
 * @returns {{ok: true, cost: number} | {ok: false, message: string}}
 */
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

/** Entero saneado dentro de [min, max]; cae al default si no es válido. */
const boundedInt = (raw, fallback, min, max) => {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};

/**
 * Clave de deduplicación de una compra: mismo usuario + mismo carrito.
 *
 * Sirve para colapsar el doble submit (doble click, reintento del usuario
 * mientras la primera request sigue en vuelo), que hoy generaría DOS juegos de
 * ventas pendientes y descontaría el stock dos veces vía trigger.
 */
const orderDedupeKey = (prefix, req) => {
  const payload = JSON.stringify({
    items: req.body.items,
    shippingMethod: req.body.shippingMethod,
    shippingCost: req.body.shippingCost,
    totalPrice: req.body.totalPrice,
  });
  const owner = (req.user && req.user.id) || req.body.buyerEmail || 'anon';
  return `${prefix}:${owner}:${crypto.createHash('sha256').update(payload).digest('hex')}`;
};

/**
 * Email del comprador: el de la cuenta autenticada, no el del body (un cliente
 * podría poner el de otra persona y que la orden le aparezca en "Mis compras").
 * El del body queda solo como respaldo si la cuenta no tiene email.
 */
const resolveBuyerEmail = (req) => req.user.email || req.body.buyerEmail;

/**
 * Dueño de una orden: por `user_id` cuando existe; las filas históricas sin
 * `user_id` (anteriores a 2026-09-18) se resuelven por email.
 */
const isOrderOwner = (order, user) => {
  if (order.user_id) return String(order.user_id) === String(user.id);
  return Boolean(
    user.email && order.buyer_email && user.email.toLowerCase() === order.buyer_email.toLowerCase()
  );
};

const getFrontendOrigin = () =>
  (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();

/** Valida el payload de creación de orden. Devuelve un mensaje de error o null. */
const validateOrderPayload = ({ buyerName, buyerEmail, items, totalPrice }) => {
  if (!buyerName || !String(buyerName).trim()) return 'El nombre del comprador es requerido.';
  if (!buyerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(buyerEmail))) {
    return 'El email del comprador no es válido.';
  }
  const lengthError = validateBuyerLengths({ buyerName, buyerEmail });
  if (lengthError) return lengthError;
  if (!Array.isArray(items) || items.length === 0) {
    return 'No hay productos en el carrito para procesar la compra.';
  }
  // Cota dura: cada ítem es un bloqueo de fila dentro de la transacción, así que
  // un carrito absurdo mantendría el lock (y una conexión del pool) demasiado tiempo.
  if (items.length > MAX_ORDER_ITEMS) {
    return `El carrito supera el máximo de ${MAX_ORDER_ITEMS} productos por compra.`;
  }
  for (const item of items) {
    if (!item || !item.productName || !String(item.productName).trim()) {
      return 'Los datos del producto son inválidos (productName).';
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return `La cantidad seleccionada de "${item.productName}" es inválida (quantity).`;
    }
    if (!Number.isFinite(item.unitPrice) || item.unitPrice <= 0) {
      return `El producto "${item.productName}" no tiene un precio válido (unitPrice).`;
    }
    if (!Number.isFinite(item.totalPrice) || item.totalPrice <= 0) {
      return `El total calculado de "${item.productName}" es inválido (totalPrice).`;
    }
    const unitsError = validateUnitsConfig(item);
    if (unitsError) return unitsError;
  }
  if (!Number.isFinite(totalPrice) || totalPrice <= 0) return 'El total final es inválido (totalPrice).';
  return null;
};

/** Arma el payload de preferencia de Mercado Pago. */
const buildPreferencePayload = ({ buyerName, buyerEmail, items, shippingCost, orderIds }) => {
  const origin = getFrontendOrigin();
  const resultUrl = `${origin}/checkout/result`;

  const mpItems = items.map((item) => ({
    title: String(item.productName).slice(0, 256),
    quantity: item.quantity,
    unit_price: Number(item.unitPrice),
    currency_id: 'ARS',
    picture_url: item.productImage || undefined,
  }));

  const surcharge = Number.isFinite(Number(shippingCost)) ? Number(shippingCost) : 0;
  if (surcharge > 0) {
    mpItems.push({ title: 'Envío', quantity: 1, unit_price: surcharge, currency_id: 'ARS' });
  }

  const preference = {
    items: mpItems,
    payer: { name: String(buyerName).trim(), email: String(buyerEmail).trim() },
    back_urls: { success: resultUrl, pending: resultUrl, failure: resultUrl },
    external_reference: orderIds.map(String).join(','),
    expires: true,
    expiration_date_to: new Date(Date.now() + MP_EXPIRY_MINUTES * 60 * 1000).toISOString(),
  };

  // MP rechaza auto_return si back_urls.success no es una URL pública (HTTPS):
  // en localhost devuelve 400 "auto_return invalid". Solo lo activamos en prod.
  if (resultUrl.startsWith('https://')) {
    preference.auto_return = 'approved';
  }

  if (process.env.MP_WEBHOOK_URL) {
    preference.notification_url = process.env.MP_WEBHOOK_URL;
  }

  return preference;
};

const fail = (status, message, code) => ({ ok: false, status, message, ...(code && { code }) });

// Header opcional de idempotencia del checkout. Sin ':' a propósito: es el
// separador que usa Order.insertPending para numerar las líneas del carrito.
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const INVALID_IDEMPOTENCY_KEY_MESSAGE =
  'El header Idempotency-Key debe tener entre 8 y 128 caracteres (letras, números, "-" y "_").';
const ORDER_ALREADY_PROCESSED_MESSAGE =
  'Esta compra ya fue procesada, cancelada o venció. Iniciá una nueva compra.';
const IDEMPOTENCY_KEY_REUSED_MESSAGE =
  'Esta compra no coincide con la que ya se había iniciado con esa misma clave. Volvé al carrito e iniciá una nueva compra.';
const IDEMPOTENCY_KEY_REUSED_CODE = 'IDEMPOTENCY_KEY_REUSED';
const reusedKeyFailure = () => fail(422, IDEMPOTENCY_KEY_REUSED_MESSAGE, IDEMPOTENCY_KEY_REUSED_CODE);

/** Cuerpo de error de una reserva fallida; `code` solo viaja cuando existe. */
const reservationErrorBody = (reservation) => ({
  success: false,
  message: reservation.message,
  ...(reservation.code && { code: reservation.code }),
});

/**
 * Lee `Idempotency-Key` (opcional).
 * @returns {{ok: true, key: string|null} | {ok: false}} `ok:false` si viene con formato inválido.
 */
const readIdempotencyKey = (req) => {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined) return { ok: true, key: null };
  return IDEMPOTENCY_KEY_RE.test(raw) ? { ok: true, key: raw } : { ok: false };
};

const respondInvalidIdempotencyKey = (res) =>
  res.status(400).json({
    success: false,
    code: 'INVALID_IDEMPOTENCY_KEY',
    message: INVALID_IDEMPOTENCY_KEY_MESSAGE,
  });

/** Parte del total de las líneas que no es producto: el envío (se cobra en la 1ª línea). */
const shippingFromRows = (rows) => {
  const total = rows.reduce((sum, row) => sum + row.total_price, 0);
  const products = rows.reduce((sum, row) => sum + row.unit_price * row.quantity, 0);
  return Math.max(0, Math.round((total - products) * 100) / 100);
};

/**
 * Reconstruye, sin tocar stock, la respuesta de una reserva previa con la misma
 * (user_id, Idempotency-Key). Tiene la misma forma que una reserva nueva.
 * @returns {Promise<object|null>} null si la key nunca se usó.
 */
const replayReservation = async (client, { userId, idempotencyKey, paymentMethod, requestHash }) => {
  const rows = await Order.findByIdempotencyKey(client, userId, idempotencyKey);
  if (rows.length === 0) return null;

  if (rows[0].payment_method !== paymentMethod) return reusedKeyFailure();
  // Filas con el formato anterior no guardaron huella: se reenvían sin comparar.
  if (rows[0].request_hash && rows[0].request_hash !== requestHash) return reusedKeyFailure();
  // Una preferencia de MP solo tiene sentido sobre órdenes todavía pendientes.
  if (paymentMethod === 'mp' && rows.some((row) => row.payment_status !== 'pendiente')) {
    return fail(409, ORDER_ALREADY_PROCESSED_MESSAGE);
  }

  logger.info('order_reserve_replayed', { userId, paymentMethod, lines: rows.length });
  return {
    ok: true,
    orderIds: rows.map((row) => row.id),
    pricedItems: rows.map((row) => ({
      productName: row.product_name,
      productImage: row.product_image,
      quantity: row.quantity,
      unitPrice: row.unit_price,
    })),
    shippingCost: shippingFromRows(rows),
  };
};

/**
 * Valida y reserva UNA línea del carrito (producto bloqueado, stock, precio de
 * la base) e inserta su venta pendiente.
 * @returns {Promise<{ok: true, orderId: string, priced: object} | {ok: false, status: number, message: string}>}
 */
const reserveLine = async (client, params, { item, index, lineSurcharge }) => {
  const productId = Number.parseInt(item.productId, 10);

  // Sin producto identificable no hay precio que validar contra la base, y
  // el precio del body no es confiable: se rechaza la compra entera.
  if (!Number.isInteger(productId)) {
    return fail(400, `No se pudo identificar el producto "${item.productName}".`);
  }

  const product = await Order.getProductForUpdate(client, productId);
  if (product === null || product.stock < item.quantity) {
    const label = product === null ? item.productName : product.name;
    return fail(409, `No hay stock suficiente de "${label}".`);
  }

  // Un producto inactivo no se publica en el catálogo: tampoco se puede comprar por id directo.
  if (product.status != null && product.status !== 'active') {
    return fail(409, `El producto "${product.name}" no está disponible para la venta.`);
  }

  // El importe SIEMPRE sale de la base, nunca del body: un cliente que
  // manipule `unitPrice`/`totalPrice` termina pagando el precio real.
  const unitPrice = resolveUnitPrice(product);
  if (!(unitPrice > 0)) {
    return fail(409, `El producto "${product.name}" no está disponible para la venta.`);
  }

  // Nombre e imagen también salen de la base: lo persistido y lo que ve el
  // comprador en Mercado Pago no lo decide el cliente.
  const priced = {
    productName: product.name,
    productImage: product.image_url,
    quantity: item.quantity,
    unitPrice,
  };
  const { buyerName, buyerEmail, userId, paymentMethod, shippingMethod, idempotencyKey, requestHash } = params;
  const orderId = await Order.insertPending(client, {
    ...priced,
    buyerName,
    buyerEmail,
    userId,
    productId,
    // El costo de envío se suma a la primera línea (mismo criterio que el frontend)
    totalPrice: unitPrice * item.quantity + lineSurcharge,
    unitsConfig: item.unitsConfig,
    paymentMethod,
    shippingMethod,
    idempotencyKey,
    requestHash,
    lineIndex: index,
  });
  return { ok: true, orderId, priced };
};

/** @returns {Promise<object|null>} fallo 429 si esta compra deja al usuario por encima del tope de pendientes. */
const checkPendingLimit = async (client, { userId, items }) => {
  if (!userId) return null;
  const pending = await Order.countPendingByUser(client, userId);
  if (pending + items.length <= maxPendingLinesPerUser()) return null;
  logger.warn('order_blocked_too_many_pending', { userId, pending });
  return fail(429, TOO_MANY_PENDING_MESSAGE, TOO_MANY_PENDING_CODE);
};

/** Cuerpo transaccional de `reserveOrders` (BEGIN ... COMMIT). El caller maneja errores y release. */
const runReservation = async (client, params) => {
  const { items, shippingMethod, shippingCost, idempotencyKey } = params;
  await client.query('BEGIN');
  if (idempotencyKey) await Order.lockIdempotencyKey(client, params.userId, idempotencyKey);

  const shipping = resolveShippingCost(shippingMethod, shippingCost);
  if (!shipping.ok) {
    await client.query('ROLLBACK');
    return fail(400, shipping.message);
  }

  const lockIds = items.map((item) => Number.parseInt(item.productId, 10)).filter(Number.isInteger);
  await Order.lockProductsInOrder(client, [...new Set(lockIds)].sort((a, b) => a - b));

  // Después de tomar los locks: si otra request con la misma key estaba en vuelo,
  // ya commiteó y se ve acá, así que el reintento no descuenta stock de nuevo.
  if (idempotencyKey) {
    const replay = await replayReservation(client, params);
    if (replay) {
      await client.query('ROLLBACK');
      return replay;
    }
  }

  const pendingError = await checkPendingLimit(client, params);
  if (pendingError) {
    await client.query('ROLLBACK');
    return pendingError;
  }

  const orderIds = [];
  // Líneas ya valorizadas por el servidor: son las que se le cobran a MP.
  const pricedItems = [];
  for (const [index, item] of items.entries()) {
    const lineSurcharge = index === 0 ? shipping.cost : 0;
    const line = await reserveLine(client, params, { item, index, lineSurcharge });
    if (!line.ok) {
      await client.query('ROLLBACK');
      return line;
    }
    orderIds.push(line.orderId);
    pricedItems.push(line.priced);
  }

  await client.query('COMMIT');
  invalidateProducts();
  return { ok: true, orderIds, pricedItems, shippingCost: shipping.cost };
};

/** Error durante la reserva: rollback y, si fue la carrera de una misma Idempotency-Key, reenvía la ganadora. */
const handleReservationError = async (client, error, params) => {
  await client.query('ROLLBACK').catch(() => undefined);

  if (params.idempotencyKey && Order.isIdempotencyConflict(error)) {
    const replay = await replayReservation(client, params).catch(() => null);
    if (replay) return replay;
  }

  logger.error('order_reserve_failed', {
    paymentMethod: params.paymentMethod,
    error: error.message,
    code: error.code,
  });
  return fail(500, 'No se pudo registrar la orden. Intentá de nuevo.');
};

/**
 * Reserva el stock e inserta las ventas pendientes en una única transacción corta.
 *
 * El trigger `trg_decrement_stock` descuenta al insertar la venta, pero con
 * `GREATEST(stock,0)`, que permitiría sobreventa silenciosa: por eso se valida
 * disponibilidad con la fila bloqueada (`FOR UPDATE`) antes de insertar. El lock
 * se mantiene hasta el COMMIT, así que las líneas posteriores del mismo producto
 * ya ven el stock que descontó el trigger en este loop, y dos compras
 * simultáneas del último ítem se serializan (una gana, la otra recibe 409).
 *
 * Con `idempotencyKey`, una reserva previa del mismo usuario y key se devuelve tal
 * cual (sin descontar stock otra vez); el índice UNIQUE parcial cubre la carrera.
 *
 * @returns {Promise<{ok: true, orderIds: string[]} | {ok: false, status: number, message: string}>}
 */
const reserveOrders = async (rawParams) => {
  const params = rawParams.idempotencyKey
    ? { ...rawParams, requestHash: orderFingerprint(rawParams) }
    : rawParams;
  const client = await pool.connect();
  try {
    return await runReservation(client, params);
  } catch (error) {
    return await handleReservationError(client, error, params);
  } finally {
    client.release();
  }
};

/**
 * Compensación: cancela reservas recién creadas y devuelve su stock.
 * Se usa cuando la reserva salió bien pero el paso siguiente falló (ej. Mercado
 * Pago no devolvió preferencia), para que el usuario vea el mismo resultado que
 * antes —nada persistido— sin haber tenido que mantener la transacción abierta
 * durante la llamada externa.
 */
const releaseOrders = async (orderIds, { releaseIdempotencyKey = false } = {}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of orderIds) {
      const order = await Order.findByIdForUpdate(client, id);
      if (!order || order.payment_status !== 'pendiente') continue;
      await Order.setStatus(client, order.id, 'cancelado');
      await Order.restoreStock(client, order.product_id, order.quantity);
      // La reserva se deshizo por una falla nuestra/de MP: el cliente debe poder
      // reintentar con la misma Idempotency-Key en vez de recibir "ya procesada".
      if (releaseIdempotencyKey) await Order.clearIdempotencyKey(client, order.id);
    }
    await client.query('COMMIT');
    invalidateProducts();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // No se propaga: el sweep de órdenes vencidas (cada 60 s) es la red de
    // seguridad si esta compensación falla.
    logger.error('orders_release_failed', { error: error.message });
  } finally {
    client.release();
  }
};

/** Mercado Pago no devolvió preferencia: se deshace la reserva y se responde 502. */
const compensateFailedPreference = async (orderIds, error, idempotencyKey) => {
  if (error.code === 'MP_TIMEOUT') {
    logger.warn('mp_create_preference_timeout', { orderIds });
  } else {
    logger.error('mp_create_preference_failed', { error: error.message, orderIds });
  }
  await releaseOrders(orderIds, { releaseIdempotencyKey: Boolean(idempotencyKey) });
  return {
    status: 502,
    body: {
      success: false,
      message: 'No se pudo conectar con Mercado Pago. Intentá de nuevo o elegí transferencia.',
    },
  };
};

/**
 * Crea preferencia de Mercado Pago sobre reservas ya confirmadas.
 *
 * La llamada HTTP a Mercado Pago queda FUERA de la transacción a propósito: si
 * se hiciera adentro, cada checkout en curso retendría una conexión del pool
 * durante todo el round trip externo (cientos de ms) y con 20 conexiones
 * bastarían 20 compras simultáneas para frenar toda la API.
 */
const buildMpCheckout = async (req, idempotencyKey) => {
  const { buyerName, items, shippingMethod, shippingCost } = req.body;
  const buyerEmail = resolveBuyerEmail(req);

  const reservation = await reserveOrders({
    buyerName, buyerEmail, userId: req.user.id, items, shippingMethod, shippingCost,
    paymentMethod: 'mp', idempotencyKey,
  });
  if (!reservation.ok) {
    return { status: reservation.status, body: reservationErrorBody(reservation) };
  }

  try {
    const preference = await mercadopago.createPreference(
      // Se le cobra al comprador lo que quedó persistido (precio de la base),
      // no lo que vino en el body.
      buildPreferencePayload({
        buyerName,
        buyerEmail,
        items: reservation.pricedItems,
        shippingCost: reservation.shippingCost,
        orderIds: reservation.orderIds,
      })
    );

    if (!preference || !preference.init_point) {
      throw new Error('Mercado Pago no devolvió init_point');
    }

    return {
      status: 201,
      body: {
        success: true,
        init_point: preference.init_point,
        order_ids: reservation.orderIds.map(String),
      },
    };
  } catch (error) {
    return compensateFailedPreference(reservation.orderIds, error, idempotencyKey);
  }
};

/**
 * @desc    Crea preferencia de Mercado Pago, registra ventas pendientes y reserva stock
 * @route   POST /api/orders/mp-preference
 */
const createMpPreference = async (req, res) => {
  const { buyerName, buyerEmail, items, totalPrice } = req.body;

  const validationError = validateOrderPayload({ buyerName, buyerEmail, items, totalPrice });
  if (validationError) {
    return res.status(400).json({ success: false, message: validationError });
  }

  const idempotency = readIdempotencyKey(req);
  if (!idempotency.ok) return respondInvalidIdempotencyKey(res);

  if (await blockIfPurchaseNotAllowed(req, res)) return;

  if (!mercadopago.isConfigured()) {
    return res.status(503).json({ success: false, message: MP_NOT_CONFIGURED_MESSAGE });
  }

  // Doble click / reintento con la primera request todavía en vuelo: se comparte
  // la misma ejecución en vez de crear dos juegos de ventas y descontar dos veces.
  const { status, body } = await caches.orders.single(
    orderDedupeKey('mp', req),
    () => buildMpCheckout(req, idempotency.key)
  );
  return res.status(status).json(body);
};

/**
 * @desc    Crea órdenes de transferencia bancaria, valida stock y reserva en la DB.
 *          Mueve el INSERT fuera del frontend (anon key + RLS) al backend (service role).
 * @route   POST /api/orders/transfer
 */
const createTransferOrder = async (req, res) => {
  const { buyerName, buyerEmail, items, shippingMethod, shippingCost, totalPrice } = req.body;

  const validationError = validateOrderPayload({ buyerName, buyerEmail, items, totalPrice });
  if (validationError) {
    return res.status(400).json({ success: false, message: validationError });
  }

  const idempotency = readIdempotencyKey(req);
  if (!idempotency.ok) return respondInvalidIdempotencyKey(res);

  if (await blockIfPurchaseNotAllowed(req, res)) return;

  const reservation = await caches.orders.single(orderDedupeKey('transfer', req), () =>
    reserveOrders({
      buyerName,
      buyerEmail: resolveBuyerEmail(req),
      userId: req.user.id,
      items,
      shippingMethod,
      shippingCost,
      paymentMethod: 'transfer',
      idempotencyKey: idempotency.key,
    })
  );

  if (!reservation.ok) {
    return res.status(reservation.status).json(reservationErrorBody(reservation));
  }
  return res.status(201).json({ success: true, order_ids: reservation.orderIds.map(String) });
};

/**
 * @desc    Compras pagadas del usuario (por email). Solo el dueño o un admin.
 * @route   GET /api/orders/user?email=...
 */
const getUserOrders = async (req, res) => {
  try {
    const email = String(req.query.email || '').trim();
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email requerido' });
    }

    const isOwner = req.user.email && req.user.email.toLowerCase() === email.toLowerCase();
    if (!isOwner && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'No podés consultar las compras de otro usuario',
      });
    }

    // Paginado con tope: "Mis compras" de un cliente fiel puede tener cientos de
    // líneas y devolverlas todas serializa un JSON grande por request.
    // El default cubre el histórico completo de un usuario normal, así que el
    // frontend actual (que no pagina) sigue funcionando igual.
    const limit = boundedInt(req.query.limit, DEFAULT_ORDER_PAGE_SIZE, 1, MAX_ORDER_PAGE_SIZE);
    const offset = boundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // El propio comprador también ve lo ligado a su user_id (aunque haya cambiado de email);
    // un admin consulta estrictamente por el email pedido.
    const { rows, total } = await Order.findPaidByEmail(email, limit, offset, isOwner ? req.user.id : null);
    return res.status(200).json({
      success: true,
      orders: rows,
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  } catch (error) {
    console.error('Error en getUserOrders:', error.message);
    return res.status(500).json({ success: false, message: 'Error al cargar las compras' });
  }
};

/**
 * @desc    Confirma contra MP un pago aprobado y marca las órdenes como pagadas.
 *          Lo llama el frontend al volver de MP con payment_id; el webhook es el respaldo.
 * @route   POST /api/orders/mp-confirm
 */
const confirmMpPayment = async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId || !isValidPaymentId(paymentId)) {
      return res.status(400).json({ success: false, message: 'paymentId requerido' });
    }
    if (!mercadopago.isConfigured()) {
      return res.status(503).json({ success: false, message: MP_NOT_CONFIGURED_MESSAGE });
    }

    // El estado se verifica directo contra MP: el cliente no puede forjar un pago.
    const payment = await mercadopago.getPayment(paymentId);
    if (!isSettleablePayment(payment)) {
      return res.status(409).json({ success: false, message: 'El pago no está aprobado' });
    }

    const ids = parseExternalReference(payment.external_reference);
    const updated = ids.length > 0
      ? await Order.markPaidByIds(ids, Number(payment.transaction_amount), PAYMENT_AMOUNT_TOLERANCE)
      : 0;

    // El monto acreditado no cubre el total de las órdenes: no se saldan.
    if (updated === -1) {
      logger.warn('mp_confirm_amount_mismatch', {
        paymentId: String(paymentId),
        paidAmount: Number(payment.transaction_amount),
        orderIds: ids,
      });
      return res.status(409).json({
        success: false,
        message: 'El monto abonado no coincide con el total de la compra.',
      });
    }

    // Un pago acreditado tarde vuelve a descontar stock: el catálogo cacheado
    // tiene que reflejarlo ya.
    if (updated > 0) invalidateProducts();

    return res.status(200).json({ success: true, orders_paid: updated });
  } catch (error) {
    if (error.code === 'MP_TIMEOUT') {
      logger.warn('mp_confirm_timeout', { paymentId: req.body && req.body.paymentId });
    } else {
      console.error('Error en confirmMpPayment:', error.message);
    }
    // El frontend puede reintentar mp-confirm sin riesgo: solo lee el estado
    // del pago contra MP, no crea ni descuenta nada por sí mismo.
    return res.status(502).json({ success: false, message: 'No se pudo verificar el pago' });
  }
};

/** `external_reference` de MP ("id1,id2,...") → ids de órdenes. */
const parseExternalReference = (reference) =>
  String(reference).split(',').map((s) => s.trim()).filter(Boolean);

/** Marca pagadas las órdenes de un pago aprobado; ignora pagos que no corresponde acreditar. */
const settleApprovedPayment = async (payment, paymentId) => {
  if (!isSettleablePayment(payment)) return;

  const ids = parseExternalReference(payment.external_reference);
  if (ids.length === 0) return;

  const updated = await Order.markPaidByIds(ids, Number(payment.transaction_amount), PAYMENT_AMOUNT_TOLERANCE);
  if (updated === -1) {
    logger.warn('mp_webhook_amount_mismatch', {
      paymentId: String(paymentId),
      paidAmount: Number(payment.transaction_amount),
      orderIds: ids,
    });
    return;
  }
  // Sin filas actualizadas el stock no cambió: no hay catálogo cacheado que invalidar.
  if (updated > 0) invalidateProducts();
};

/**
 * Firma HMAC de MP. Con `MP_WEBHOOK_SECRET` definida es obligatoria: firma ausente
 * o inválida corta con 401 (no se consulta ni se toca nada). Sin secreto se sigue
 * adelante —el pago se revalida igual contra la API de MP— pero se deja el aviso.
 * @returns {boolean} true si la request fue rechazada (ya se respondió).
 */
const rejectIfSignatureInvalid = (req, res, paymentId) => {
  const signatureValid = mercadopago.verifyWebhookSignature({
    signatureHeader: req.headers['x-signature'],
    requestId: req.headers['x-request-id'],
    dataId: paymentId,
  });

  if (signatureValid === null) {
    logger.warn('mp_webhook_unsigned', { paymentId: paymentId ? String(paymentId) : null });
    return false;
  }
  if (signatureValid) return false;

  logger.warn('mp_webhook_invalid_signature', { paymentId: paymentId ? String(paymentId) : null });
  res.status(401).json({ success: false });
  return true;
};

/**
 * @desc    Webhook de Mercado Pago (server a server). Marca pagadas las órdenes aprobadas.
 * @route   POST /api/orders/mp-webhook
 */
const mpWebhook = async (req, res) => {
  try {
    const topic = req.query.type || req.query.topic || (req.body && req.body.type);
    const paymentId =
      req.query['data.id'] || (req.body && req.body.data && req.body.data.id) || req.query.id;

    // La firma se exige antes de decidir si la notificación nos interesa: así un
    // request sin firma válida no obtiene ni un 200 de cortesía cuando hay secreto.
    if (rejectIfSignatureInvalid(req, res, paymentId)) return;

    if (topic !== 'payment' || !isValidPaymentId(paymentId) || !mercadopago.isConfigured()) {
      return res.status(200).json({ success: true });
    }

    await settleApprovedPayment(await mercadopago.getPayment(paymentId), paymentId);
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error.code === 'MP_TIMEOUT') {
      logger.warn('mp_webhook_timeout', { paymentId: req.query && (req.query['data.id'] || req.query.id) });
    } else {
      logger.error('mp_webhook_failed', { error: error.message });
    }
    // 500 hace que MP reintente la notificación más tarde
    return res.status(500).json({ success: false });
  }
};

/**
 * @desc    Cancela una orden MP pendiente (usuario volvió sin pagar) y devuelve stock
 * @route   POST /api/orders/:id/cancel
 */
const cancelOrder = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const order = await Order.findByIdForUpdate(client, req.params.id);
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }

    if (!isOrderOwner(order, req.user) && req.user.role !== 'admin') {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'No podés cancelar esta orden' });
    }

    if (order.payment_method !== 'mp') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Solo se cancelan órdenes de Mercado Pago por esta vía' });
    }

    // Idempotente: si el sweep ya la expiró (y devolvió stock), no hay nada que hacer
    if (['cancelado', 'expirado'].includes(order.payment_status)) {
      await client.query('COMMIT');
      return res.status(200).json({ success: true, message: 'La orden ya estaba cancelada' });
    }

    if (order.payment_status !== 'pendiente') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'La orden ya fue pagada y no puede cancelarse' });
    }

    await Order.setStatus(client, order.id, 'cancelado');
    await Order.restoreStock(client, order.product_id, order.quantity);

    await client.query('COMMIT');
    invalidateProducts();
    return res.status(200).json({ success: true, message: 'Orden cancelada' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Error en cancelOrder:', error.message);
    return res.status(500).json({ success: false, message: 'Error al cancelar la orden' });
  } finally {
    client.release();
  }
};

/**
 * Cambia el estado de una orden de transferencia pendiente (uso interno de
 * confirmTransfer / cancelTransfer). El stock se descuenta al INSERTAR la venta
 * (trigger trg_decrement_stock), así que:
 *  - confirmar el pago NO toca stock (ya estaba descontado);
 *  - cancelar DEVUELVE el stock que el trigger había descontado.
 */
const resolveTransferOrder = async (req, res, targetStatus) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const order = await Order.findByIdForUpdate(client, req.params.id);
    if (!order) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Orden no encontrada' });
    }
    if (order.payment_method !== 'transfer') {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'La orden no es de transferencia' });
    }
    if (order.payment_status !== 'pendiente') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `La orden ya no está pendiente (estado actual: ${order.payment_status})`,
      });
    }

    if (targetStatus === 'cancelado') {
      await Order.restoreStock(client, order.product_id, order.quantity);
    }

    await Order.setStatus(client, order.id, targetStatus);
    await client.query('COMMIT');
    if (targetStatus === 'cancelado') invalidateProducts();
    return res.status(200).json({
      success: true,
      message: targetStatus === 'pagado' ? 'Pago confirmado' : 'Orden cancelada',
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Error al resolver orden de transferencia:', error.message);
    return res.status(500).json({ success: false, message: 'Error al actualizar la orden' });
  } finally {
    client.release();
  }
};

/**
 * @desc    Admin confirma que llegó la transferencia → 'pagado' + descuenta stock
 * @route   PATCH /api/orders/:id/confirm-transfer
 */
const confirmTransfer = (req, res) => resolveTransferOrder(req, res, 'pagado');

/**
 * @desc    Admin cancela una orden de transferencia pendiente → 'cancelado'
 * @route   PATCH /api/orders/:id/cancel-transfer
 */
const cancelTransfer = (req, res) => resolveTransferOrder(req, res, 'cancelado');

/** Solo se actúa sobre órdenes de transferencia, pendientes y del propio usuario (o admin). */
const canActOnNudgeOrder = (order, user) => {
  if (!order || order.payment_method !== 'transfer' || order.payment_status !== 'pendiente') {
    return false;
  }
  return isOrderOwner(order, user) || user.role === 'admin';
};

/** Aplica la respuesta del nudge: 'wa_abandonado' cancela + devuelve stock; el resto solo marca origin. */
const applyNudgeToOrder = async (client, order, origin) => {
  if (origin === NUDGE_ORIGIN.abandonado) {
    await Order.restoreStock(client, order.product_id, order.quantity);
    await Order.setStatus(client, order.id, 'cancelado');
  }
  await Order.setOrigin(client, order.id, origin);
};

/**
 * @desc    Registra la respuesta del nudge post-WhatsApp del checkout transferencia.
 *          'abandonado' cancela las órdenes y devuelve stock; el resto solo marca `origin`.
 * @route   POST /api/orders/nudge
 */
const recordNudge = async (req, res) => {
  const { orderIds, response } = req.body || {};
  const origin = NUDGE_ORIGIN[response];

  if (!origin) {
    return res.status(400).json({ success: false, message: 'Respuesta de nudge inválida' });
  }
  if (!Array.isArray(orderIds) || orderIds.length === 0 || orderIds.length > MAX_NUDGE_ORDERS) {
    return res.status(400).json({ success: false, message: 'Lista de órdenes inválida' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let applied = 0;
    for (const id of orderIds) {
      const order = await Order.findByIdForUpdate(client, id);
      if (!canActOnNudgeOrder(order, req.user)) continue;
      await applyNudgeToOrder(client, order, origin);
      applied += 1;
    }
    await client.query('COMMIT');
    if (origin === NUDGE_ORIGIN.abandonado && applied > 0) invalidateProducts();
    return res.status(200).json({ success: true, applied });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Error en recordNudge:', error.message);
    return res.status(500).json({ success: false, message: 'No se pudo registrar la respuesta' });
  } finally {
    client.release();
  }
};

/** Sweep periódico: expira órdenes pendientes vencidas (lo programa server.js). */
let sweepRunning = false;
const expireStaleOrders = async () => {
  if (sweepRunning) return;
  sweepRunning = true;
  try {
    const { mp, transfer } = await Order.expireStale(MP_EXPIRY_MINUTES, TRANSFER_EXPIRY_HOURS);
    if (mp > 0 || transfer > 0) {
      invalidateProducts(); // el sweep devolvió stock: el catálogo cacheado quedó viejo
      logger.info('orders_sweep', { expiredMp: mp, expiredTransfer: transfer });
    }
  } catch (error) {
    console.error('Error en sweep de órdenes:', error.message);
  } finally {
    sweepRunning = false;
  }
};

module.exports = {
  createMpPreference,
  createTransferOrder,
  getUserOrders,
  confirmMpPayment,
  mpWebhook,
  cancelOrder,
  confirmTransfer,
  cancelTransfer,
  recordNudge,
  expireStaleOrders,
  // Expuesto solo para el test de concurrencia (qa/concurrency-stock-test.js):
  // permite invocar la transacción BEGIN/FOR UPDATE/COMMIT directo, sin pasar
  // por auth ni por el single-flight de `caches.orders` (que colapsaría 50
  // llamadas del mismo usuario en una sola y no probaría nada).
  reserveOrders,
};
