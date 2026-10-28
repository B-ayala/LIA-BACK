const Withdrawal = require('../models/Withdrawal');
const logger = require('../utils/logger');
const { notifyWithdrawalReceived } = require('../services/withdrawalNotifications');
const { sendError } = require('../utils/httpResponses');
const { boundedInt } = require('../utils/boundedInt');
const { WITHDRAWAL_STATUSES } = require('../schemas/withdrawalSchema');

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const serverError = (res, action, error) => {
  logger.error(`withdrawals_${action}_failed`, { code: error.code, message: error.message });
  return sendError(res, 500, 'INTERNAL_ERROR', 'No pudimos completar la operación. Reintentá en unos segundos.');
};

/**
 * @desc    Registra una solicitud de arrepentimiento (público, sin login) y devuelve su
 *          código de seguimiento. Sin compra coincidente igual se guarda, marcada para
 *          revisión manual. La respuesta NO indica si hubo coincidencia: así el endpoint
 *          no sirve para averiguar qué emails tienen compras.
 * @route   POST /api/withdrawals
 */
const createWithdrawal = async (req, res) => {
  try {
    const { name, email, description, orderNumber, purchaseDate, purchaseAmount } = req.body;
    const { ids: ventaIds, exact } = await Withdrawal.findPurchaseIds(email, { orderNumber, purchaseDate });
    // Sin vínculo exacto (faltan datos o no coinciden) el admin la revisa a mano.
    const needsReview = !exact;
    const { code, createdAt } = await Withdrawal.create({
      name, email, description, orderNumber, purchaseDate, purchaseAmount, ventaIds, needsReview,
    });
    logger.info('withdrawal_received', { code, linkedPurchases: ventaIds.length, needsReview });
    notifyWithdrawalReceived({
      name, email, description, orderNumber, purchaseDate, purchaseAmount, code, needsReview, receivedAt: createdAt,
    });
    return res.status(201).json({ success: true, code, receivedAt: createdAt });
  } catch (error) {
    return serverError(res, 'create', error);
  }
};

/**
 * @desc    Lista las solicitudes (admin), más nuevas primero, con las compras vinculadas.
 * @route   GET /api/withdrawals?status=&limit=&offset=
 */
const listWithdrawals = async (req, res) => {
  try {
    const { status } = req.query;
    if (status !== undefined && !WITHDRAWAL_STATUSES.includes(status)) {
      return sendError(res, 400, 'INVALID_STATUS', 'El estado indicado no es válido.');
    }
    const limit = boundedInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = boundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const { rows, total } = await Withdrawal.findPage({ status, limit, offset });
    return res.json({ success: true, data: rows, total, limit, offset, hasMore: offset + rows.length < total });
  } catch (error) {
    return serverError(res, 'list', error);
  }
};

/**
 * @desc    Cambia el estado y/o la nota interna de una solicitud (admin).
 * @route   PATCH /api/withdrawals/:id
 */
const updateWithdrawal = async (req, res) => {
  try {
    const updated = await Withdrawal.update(req.params.id, req.body);
    if (!updated) return sendError(res, 404, 'WITHDRAWAL_NOT_FOUND', 'Solicitud no encontrada');
    logger.info('withdrawal_updated', { id: req.params.id, status: updated.status, actor: req.user.id });
    return res.json({ success: true, data: updated });
  } catch (error) {
    return serverError(res, 'update', error);
  }
};

module.exports = { createWithdrawal, listWithdrawals, updateWithdrawal };
