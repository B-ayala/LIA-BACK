/**
 * Middleware genérico de validación de borde con Zod.
 * Reemplaza `req.body` por los datos ya parseados/coeridos del schema, para
 * que el controller trabaje siempre con tipos confiables.
 */
const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'Los datos enviados no son válidos.',
      details: result.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      })),
    });
  }

  req.body = result.data;
  next();
};

module.exports = { validateBody };
