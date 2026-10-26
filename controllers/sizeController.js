const Size = require('../models/Size');
const logger = require('../utils/logger');
const { sendError } = require('../utils/httpResponses');

const WRITE_FAILURES = {
  duplicate: [409, 'SIZE_DUPLICATE', 'Ya existe un talle con ese nombre para ese tipo.'],
  not_found: [404, 'SIZE_NOT_FOUND', 'Talle no encontrado'],
  empty: [400, 'NO_FIELDS', 'No hay campos para actualizar'],
};

const serverError = (res, action, error) => {
  logger.error(`sizes_${action}_failed`, { error: error.message, code: error.code });
  return sendError(res, 500, 'INTERNAL_ERROR', 'No se pudo completar la operación. Reintentá en unos segundos.');
};

const respondWrite = (res, result, successStatus) => {
  if (result.status !== 'ok') {
    const [status, code, message] = WRITE_FAILURES[result.status];
    return sendError(res, status, code, message);
  }
  return res.status(successStatus).json({ success: true, data: result.size });
};

const getSizes = async (_req, res) => {
  try {
    return res.json({ success: true, data: await Size.findAll() });
  } catch (error) {
    return serverError(res, 'list', error);
  }
};

const createSize = async (req, res) => {
  try {
    return respondWrite(res, await Size.create(req.body), 201);
  } catch (error) {
    return serverError(res, 'create', error);
  }
};

const updateSize = async (req, res) => {
  try {
    return respondWrite(res, await Size.update(req.params.id, req.body), 200);
  } catch (error) {
    return serverError(res, 'update', error);
  }
};

module.exports = { getSizes, createSize, updateSize };
