const express = require('express');
const router = express.Router();
const {
  createMpPreference,
  createTransferOrder,
  getUserOrders,
  confirmMpPayment,
  mpWebhook,
} = require('../controllers/orderController');
const { cancelOrder, cancelMpOrders, recordNudge } = require('../controllers/orderCancellationController');
const {
  confirmTransfer,
  cancelTransfer,
  confirmLateTransferOrder,
} = require('../controllers/transferOrderController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { createRateLimit } = require('../middleware/rateLimit');
const { noStore } = require('../middleware/httpCache');
const { validateOrderIdParam } = require('../middleware/validateParams');

// Crear una compra es la operación más cara del sistema (transacción + locks de
// stock + llamada externa a MP). El límite es holgado para un humano comprando
// y cortante para un script que intente vaciar el stock a fuerza de reservas.
const checkoutLimit = createRateLimit({ name: 'orders-checkout', windowMs: 60 * 1000, max: 12 });

// Mutaciones de estado sobre órdenes propias.
const orderMutationLimit = createRateLimit({ name: 'orders-mutation', windowMs: 60 * 1000, max: 40 });

// El webhook lo llama Mercado Pago y puede reintentar en ráfaga: límite por IP
// más alto, sólo como cota ante un flood desde ese origen.
const webhookLimit = createRateLimit({ name: 'orders-webhook', windowMs: 60 * 1000, max: 240 });

// Ninguna respuesta de órdenes es cacheable: son datos personales y de estado.
router.use(noStore);

// Los ids de venta son uuid: cualquier otro formato es 400 antes de tocar la base.
router.param('id', validateOrderIdParam);

// ─── Pública (server a server, la llama Mercado Pago) ───
router.post('/mp-webhook', webhookLimit, mpWebhook);

// ─── Usuario autenticado ───
router.post('/transfer', checkoutLimit, authMiddleware, createTransferOrder);
router.post('/mp-preference', checkoutLimit, authMiddleware, createMpPreference);
router.post('/mp-confirm', orderMutationLimit, authMiddleware, confirmMpPayment);
router.post('/mp-cancel', orderMutationLimit, authMiddleware, cancelMpOrders);
router.get('/user', orderMutationLimit, authMiddleware, getUserOrders);
router.post('/nudge', orderMutationLimit, authMiddleware, recordNudge);
router.post('/:id/cancel', orderMutationLimit, authMiddleware, cancelOrder);

// ─── Solo admin ───
router.patch('/:id/confirm-transfer', orderMutationLimit, authMiddleware, adminMiddleware, confirmTransfer);
router.patch('/:id/cancel-transfer', orderMutationLimit, authMiddleware, adminMiddleware, cancelTransfer);
router.patch(
  '/:id/confirm-late-transfer', orderMutationLimit, authMiddleware, adminMiddleware, confirmLateTransferOrder
);

module.exports = router;
