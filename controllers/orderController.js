const crypto = require('crypto');
const Order = require('../models/Order');
const User = require('../models/User');
const TermsAcceptance = require('../models/TermsAcceptance');
const mercadopago = require('../utils/mercadopago');
const logger = require('../utils/logger');
const { caches } = require('../utils/cache');
const { flushAvailabilityChange } = require('../utils/catalogInvalidation');
const { sendError } = require('../utils/httpResponses');
const { readIdempotencyKey, withIdempotency } = require('../utils/idempotency');
const { parseCheckoutBody } = require('../schemas/checkoutSchema');
const { attemptFingerprint } = require('../utils/checkoutAttempt');
const {
  settleApprovedPayment, flagReversedPayment, isReversedPayment, resolveOrderIds, AMOUNT_MISMATCH,
} = require('../utils/paymentSettlement');
const { isOrderOwnerOrAdmin } = require('../utils/orderAccess');
const { buildMpCheckout, buildTransferCheckout } = require('../services/checkout');

const MP_NOT_CONFIGURED_MESSAGE =
  'Los pagos con Mercado Pago no están disponibles en este momento. Podés pagar por transferencia.';

// Mensaje mostrado cuando el admin activó el modo de compra restringida
// (ver User.getPurchasePermission) y el usuario actual no está en la lista
// de compradores habilitados.
const PURCHASES_DISABLED_MESSAGE =
  'Por el momento no es posible comprar. Sitio en mantenimiento, gracias por tu paciencia.';

const HTTP_CREATED = 201;
const DEFAULT_ORDER_PAGE_SIZE = 200;
const MAX_ORDER_PAGE_SIZE = 500;
// Los ids de pago de Mercado Pago son enteros: cualquier otra forma no llega a su API.
const PAYMENT_ID_PATTERN = /^\d{1,20}$/;

/** Entero saneado dentro de [min, max]; cae al default si no es válido. */
const boundedInt = (raw, fallback, min, max) => {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};

/**
 * Datos de la compra tal como se van a persistir, a partir del body ya validado. El email del
 * comprador es el de la sesión cuando existe (no el del body): la venta queda asociada a quien
 * pagó y "Mis compras" / la autorización por dueño no se pueden desviar a otro email.
 */
const checkoutInput = (req, body) => ({
  buyerName: body.buyerName,
  buyerEmail: (req.user && req.user.email) || body.buyerEmail,
  userId: req.user.id,
  items: body.items,
  shippingMethod: body.shippingMethod,
  shippingCost: body.shippingCost,
  // El total que el comprador vio y aceptó: no decide el cobro (lo calcula el servidor),
  // solo frena la compra si el precio cambió en el medio.
  expectedTotal: body.totalPrice,
});

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** Una respuesta recordada solo se reenvía mientras sus ventas sigan pendientes (no canceladas/vencidas/pagadas). */
const isAttemptAlive = (saved) => Order.areAllPending(saved.body && saved.body.order_ids);

/**
 * Huella de una compra: mismo comprador + mismo carrito. Colapsa el doble submit
 * (doble click, reintento con la primera request en vuelo) que si no generaría DOS
 * juegos de ventas pendientes y descontaría el stock dos veces vía trigger.
 */
const cartFingerprint = (input) => {
  const payload = JSON.stringify({
    buyerName: String(input.buyerName).trim(),
    buyerEmail: String(input.buyerEmail).trim(),
    items: input.items,
    shippingMethod: input.shippingMethod,
    shippingCost: input.shippingCost,
    totalPrice: input.expectedTotal,
  });
  return sha256(payload);
};

/**
 * Ejecuta la creación de una compra respetando `Idempotency-Key` (replay del
 * resultado exitoso) y, debajo, el single-flight por carrito para el doble submit
 * sin header. El `{ status, body }` de `build` (incluido `code`) llega tal cual al cliente.
 */
const runCheckout = async (prefix, req, res, input, build) => {
  const idempotency = readIdempotencyKey(req);
  if (idempotency.error) {
    return res.status(idempotency.error.status).json(idempotency.error.body);
  }
  const fingerprint = cartFingerprint(input);
  // La huella que se guarda en cada venta incluye el medio de pago: una key no cruza mp/transferencia.
  const attempt = idempotency.key
    ? { key: idempotency.key, fingerprint: attemptFingerprint(sha256(`${prefix}:${fingerprint}`)) }
    : null;
  const { status, body } = await withIdempotency({
    scope: `${prefix}:${req.user.id}`,
    key: idempotency.key,
    fingerprint,
    isReplayable: (saved) => isAttemptAlive(saved),
    execute: () => caches.orders.single(
      `${prefix}:${req.user.id}:${fingerprint}`,
      () => build({ ...input, idempotency: attempt })
    ),
  });
  return res.status(status).json(body);
};

/** Corta el checkout si el modo de compra restringida está activo y este usuario no está habilitado. */
const isPurchaseBlocked = async (req) => {
  const { allowed } = await User.getPurchasePermission(req.user.id);
  if (!allowed) logger.warn('order_blocked_purchases_disabled', { userId: req.user.id });
  return !allowed;
};

/**
 * Deja constancia de la versión de los Términos vigente en la compra recién creada. La versión la fija
 * el servidor (no el body): el cliente no puede dejar constancia de otra. Un fallo no corta el
 * checkout (la compra ya está reservada): queda en el log.
 */
const withTermsAcceptance = (build, req, termsVersion) => async (input) => {
  const result = await build(input);
  if (result.status !== HTTP_CREATED || result.replayed) return result;
  try {
    await TermsAcceptance.record({
      userId: req.user.id,
      buyerEmail: input.buyerEmail,
      orderNumber: result.body.order_number,
      termsVersion,
      ip: req.ip,
    });
  } catch (error) {
    logger.error('terms_acceptance_not_saved', { userId: req.user.id, code: error.code, message: error.message });
  }
  return result;
};

const startCheckout = async (req, res, prefix, build) => {
  try {
    // Todo el body se valida acá, antes de tomar cualquier lock de producto.
    const parsed = parseCheckoutBody(req.body);
    if (!parsed.ok) return sendError(res, 400, 'VALIDATION_ERROR', parsed.message, { details: parsed.details });
    const input = checkoutInput(req, parsed.data);
    if (await isPurchaseBlocked(req)) return sendError(res, 403, 'PURCHASES_DISABLED', PURCHASES_DISABLED_MESSAGE);
    if (prefix === 'mp' && !mercadopago.isConfigured()) {
      return sendError(res, 503, 'MP_NOT_CONFIGURED', MP_NOT_CONFIGURED_MESSAGE);
    }
    // La aceptación se pide al registrarse, no al comprar: solo se deja constancia si ya la había dado.
    const terms = await TermsAcceptance.statusFor(req.user);
    const buildWithEvidence = terms.accepted ? withTermsAcceptance(build, req, terms.currentVersion) : build;
    return await runCheckout(prefix, req, res, input, buildWithEvidence);
  } catch (error) {
    logger.error('checkout_failed', { prefix, code: error.code, message: error.message });
    if (res.headersSent) return undefined;
    return sendError(res, 500, 'CHECKOUT_FAILED', 'No se pudo registrar la orden. Intentá de nuevo.');
  }
};

/**
 * @desc    Reserva stock, registra ventas pendientes y crea la preferencia de Mercado Pago
 * @route   POST /api/orders/mp-preference
 */
const createMpPreference = (req, res) => startCheckout(req, res, 'mp', buildMpCheckout);

/**
 * @desc    Crea órdenes de transferencia bancaria, valida stock y reserva en la DB.
 * @route   POST /api/orders/transfer
 */
const createTransferOrder = (req, res) => startCheckout(req, res, 'transfer', buildTransferCheckout);

/**
 * @desc    Compras del usuario (por email): pagadas + transferencias con comprobante avisado.
 *          Solo el dueño o un admin.
 * @route   GET /api/orders/user?email=...
 */
const getUserOrders = async (req, res) => {
  try {
    const email = String(req.query.email || '').trim();
    if (!email) return sendError(res, 400, 'EMAIL_REQUIRED', 'Email requerido');

    const isOwner = req.user.email && req.user.email.toLowerCase() === email.toLowerCase();
    if (!isOwner && req.user.role !== 'admin') {
      return sendError(res, 403, 'FORBIDDEN', 'No podés consultar las compras de otro usuario');
    }

    // Paginado con tope; el default cubre el histórico de un usuario normal, así
    // que el frontend actual (que no pagina) sigue funcionando igual.
    const limit = boundedInt(req.query.limit, DEFAULT_ORDER_PAGE_SIZE, 1, MAX_ORDER_PAGE_SIZE);
    const offset = boundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const { rows, total } = await Order.findPurchasesByEmail(email, limit, offset);
    return res.status(200).json({
      success: true, orders: rows, total, limit, offset, hasMore: offset + rows.length < total,
    });
  } catch (error) {
    logger.error('user_orders_failed', { code: error.code, message: error.message });
    return sendError(res, 500, 'INTERNAL_ERROR', 'Error al cargar las compras');
  }
};

const logMpFailure = (event, paymentId, error) => {
  const context = { paymentId: paymentId == null ? null : String(paymentId), code: error.code, message: error.message };
  if (error.code === 'MP_TIMEOUT') logger.warn(`${event}_timeout`, context);
  else logger.error(`${event}_failed`, context);
};

/**
 * ¿Las ventas de este pago son del usuario (o es admin)? El `external_reference` lo pone la tienda al crear
 * la preferencia, pero cualquier usuario autenticado puede mandar el `paymentId` de OTRO comprador: sin este
 * control, `mp-confirm` saldaría compras ajenas (IDOR). Un pago sin ventas asociadas no tiene nada que proteger.
 */
const paymentBelongsToUser = async (user, payment) => {
  const ids = await resolveOrderIds(payment.external_reference);
  if (ids.length === 0) return true;
  const orders = await Order.findByIds(ids);
  return orders.every((order) => isOrderOwnerOrAdmin(user, order));
};

/**
 * @desc    Confirma contra MP un pago aprobado y marca las órdenes como pagadas.
 *          Lo llama el frontend al volver de MP con payment_id; el webhook es el respaldo.
 * @route   POST /api/orders/mp-confirm
 */
const confirmMpPayment = async (req, res) => {
  const paymentId = req.body && req.body.paymentId != null ? String(req.body.paymentId) : '';
  if (!PAYMENT_ID_PATTERN.test(paymentId)) return sendError(res, 400, 'PAYMENT_ID_REQUIRED', 'paymentId requerido');
  if (!mercadopago.isConfigured()) return sendError(res, 503, 'MP_NOT_CONFIGURED', MP_NOT_CONFIGURED_MESSAGE);

  try {
    // El estado se verifica directo contra MP: el cliente no puede forjar un pago.
    const payment = await mercadopago.getPayment(paymentId);
    if (!payment || payment.status !== 'approved' || !payment.external_reference) {
      return sendError(res, 409, 'PAYMENT_NOT_APPROVED', 'El pago no está aprobado');
    }

    if (!(await paymentBelongsToUser(req.user, payment))) {
      logger.warn('mp_confirm_forbidden', { userId: req.user.id, paymentId });
      return sendError(res, 403, 'FORBIDDEN', 'No podés confirmar este pago');
    }

    const updated = await settleApprovedPayment(payment);
    if (updated === AMOUNT_MISMATCH) {
      return sendError(res, 409, 'AMOUNT_MISMATCH', 'El monto abonado no coincide con el total de la compra.');
    }
    // Un pago acreditado tarde vuelve a descontar stock: el catálogo cacheado tiene que reflejarlo.
    if (updated > 0) flushAvailabilityChange();
    return res.status(200).json({ success: true, orders_paid: updated });
  } catch (error) {
    logMpFailure('mp_confirm', paymentId, error);
    // Reintentar mp-confirm es seguro: solo lee el pago en MP y salda de forma idempotente.
    return sendError(res, 502, 'PAYMENT_VERIFICATION_FAILED', 'No se pudo verificar el pago');
  }
};

const readWebhookNotification = (req) => ({
  topic: req.query.type || req.query.topic || (req.body && req.body.type),
  paymentId: req.query['data.id'] || (req.body && req.body.data && req.body.data.id) || req.query.id,
});

/**
 * Aprobado → se salda. Reembolsado / contracargado (o aprobado con devolución parcial)
 * → solo se marca para revisión del admin; no se toca el estado ni el stock.
 */
const applyWebhookPayment = async (payment) => {
  if (!payment || !payment.external_reference) return;
  if (payment.status === 'approved') {
    const updated = await settleApprovedPayment(payment);
    if (updated > 0) flushAvailabilityChange();
  }
  if (isReversedPayment(payment)) await flagReversedPayment(payment);
};

let missingSecretAlerted = false;

const isProduction = () => process.env.NODE_ENV === 'production';

// Salida provisoria y explícita para producción sin secreto: hay que activarla a propósito y se alerta al arrancar.
const allowsUnsignedWebhook = () => process.env.MP_WEBHOOK_ALLOW_UNSIGNED === 'true';

/**
 * Sin `MP_WEBHOOK_SECRET` el webhook no puede autenticar a quien llama. En producción FALLA CERRADO (401): un
 * atacante no puede disparar consultas a MP ni saldos con notificaciones falsas, y los pagos igual se confirman
 * por `mp-confirm` y por el sweep de conciliación. Se alerta una sola vez por proceso para no inundar el log.
 */
const failClosedWithoutSecret = (res) => {
  if (!missingSecretAlerted) {
    missingSecretAlerted = true;
    logger.error('mp_webhook_secret_missing', { action: 'rejecting_all_webhooks', env: 'MP_WEBHOOK_SECRET' });
  }
  return res.status(401).json({
    success: false, code: 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook no autenticable',
  });
};

/**
 * Firma HMAC de MP. `null` = no hay secreto configurado: en producción se rechaza; en desarrollo/test se sigue
 * (con advertencia) porque el pago se revalida igual contra la API de MP.
 * @returns {object|null} la respuesta ya enviada si se rechazó; null si se puede seguir.
 */
const rejectUnverifiedWebhook = (req, res, paymentId) => {
  const signatureValid = mercadopago.verifyWebhookSignature({
    signatureHeader: req.headers['x-signature'],
    requestId: req.headers['x-request-id'],
    dataId: paymentId,
  });
  if (signatureValid === false) {
    logger.warn('mp_webhook_invalid_signature', { paymentId: String(paymentId) });
    return res.status(401).json({ success: false, code: 'INVALID_SIGNATURE', message: 'Firma inválida' });
  }
  if (signatureValid !== null) return null;
  if (isProduction() && !allowsUnsignedWebhook()) return failClosedWithoutSecret(res);
  logger.warn('mp_webhook_unsigned_allowed', { env: 'MP_WEBHOOK_SECRET', nodeEnv: process.env.NODE_ENV || 'unset' });
  return null;
};

/**
 * @desc    Webhook de Mercado Pago (server a server). Topics no relevantes → 200 sin hacer nada.
 * @route   POST /api/orders/mp-webhook
 */
const mpWebhook = async (req, res) => {
  const { topic, paymentId } = readWebhookNotification(req);
  if (topic !== 'payment' || !paymentId || !mercadopago.isConfigured()) {
    return res.status(200).json({ success: true });
  }

  const rejection = rejectUnverifiedWebhook(req, res, paymentId);
  if (rejection) return rejection;
  if (!PAYMENT_ID_PATTERN.test(String(paymentId))) {
    // 200 y no 4xx: no hay nada que reintentar, y no se le consulta a MP un id que no es suyo.
    logger.warn('mp_webhook_invalid_payment_id', { paymentId: String(paymentId).slice(0, 64) });
    return res.status(200).json({ success: true });
  }

  try {
    await applyWebhookPayment(await mercadopago.getPayment(paymentId));
    return res.status(200).json({ success: true });
  } catch (error) {
    logMpFailure('mp_webhook', paymentId, error);
    // 500 hace que MP reintente la notificación más tarde.
    return sendError(res, 500, 'WEBHOOK_FAILED', 'No se pudo procesar la notificación');
  }
};

module.exports = {
  createMpPreference,
  createTransferOrder,
  getUserOrders,
  confirmMpPayment,
  mpWebhook,
};
