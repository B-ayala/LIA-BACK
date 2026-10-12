const logger = require('../utils/logger');
const { sendError } = require('../utils/httpResponses');
const { resolvePendingTransfer, confirmLateTransfer } = require('../services/transferResolution');

/** Ejecuta una resolución de transferencia y la traduce a HTTP. */
const respondResolution = async (req, res, action, run, successBody) => {
  try {
    const result = await run(req.params.id);
    if (!result.ok) return sendError(res, result.status, result.code, result.message);
    return res.status(200).json(successBody(result));
  } catch (error) {
    logger.error(`${action}_failed`, { orderId: req.params.id, code: error.code, message: error.message });
    return sendError(res, 500, 'INTERNAL_ERROR', 'Error al actualizar la orden');
  }
};

/**
 * @desc    Admin confirma que llegó la transferencia → 'pagado' (el stock ya estaba descontado)
 * @route   PATCH /api/orders/:id/confirm-transfer
 */
const confirmTransfer = (req, res) => respondResolution(req, res, 'confirm_transfer',
  (id) => resolvePendingTransfer(id, 'pagado'),
  () => ({ success: true, message: 'Pago confirmado' }));

/**
 * @desc    Admin cancela una orden de transferencia pendiente → 'cancelado' + stock devuelto
 * @route   PATCH /api/orders/:id/cancel-transfer
 */
const cancelTransfer = (req, res) => respondResolution(req, res, 'cancel_transfer',
  (id) => resolvePendingTransfer(id, 'cancelado'),
  () => ({ success: true, message: 'Orden cancelada' }));

/**
 * @desc    Admin confirma una transferencia que ya había EXPIRADO (pagó tarde) → 'pagado'.
 *          Vuelve a descontar stock; si ya no hay, `oversold: true` (reembolsar o reponer).
 * @route   PATCH /api/orders/:id/confirm-late-transfer
 */
const confirmLateTransferOrder = (req, res) => respondResolution(req, res, 'confirm_late_transfer',
  confirmLateTransfer,
  (result) => ({ success: true, oversold: result.oversold }));

module.exports = { confirmTransfer, cancelTransfer, confirmLateTransferOrder };
