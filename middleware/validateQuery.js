/**
 * Validación de borde del query string con Zod (gemelo de `validateBody`).
 * Deja el resultado ya parseado en `req.validatedQuery`: `req.query` no se pisa
 * porque Express lo expone como getter en versiones recientes.
 */
const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);

  if (!result.success) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'Los filtros enviados no son válidos.',
      details: result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'query',
        message: issue.message,
      })),
    });
  }

  req.validatedQuery = result.data;
  return next();
};

module.exports = { validateQuery };
