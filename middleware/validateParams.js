/**
 * Validación de borde de los ids de ruta (`router.param('id', ...)`): un id con
 * formato inválido responde 400 prolijo y nunca llega a la base (donde terminaría
 * en un error de cast → 500).
 */

const { isUuid } = require('../utils/uuid');
const { parseProductId } = require('../utils/checkoutRules');
const { sendError } = require('../utils/httpResponses');

const validateOrderIdParam = (req, res, next, id) => {
  if (!isUuid(id)) return sendError(res, 400, 'INVALID_ORDER_ID', 'El identificador de la orden no es válido.');
  return next();
};

const validateProductIdParam = (req, res, next, id) => {
  if (parseProductId(id) === null) {
    return sendError(res, 400, 'INVALID_PRODUCT_ID', 'El identificador del producto no es válido.');
  }
  return next();
};

const validateSizeIdParam = (req, res, next, id) => {
  if (!isUuid(id)) return sendError(res, 400, 'INVALID_SIZE_ID', 'El identificador del talle no es válido.');
  return next();
};

module.exports = { validateOrderIdParam, validateProductIdParam, validateSizeIdParam };
