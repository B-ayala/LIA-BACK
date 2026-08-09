// Tarifa plana de Correo Argentino — debe coincidir con SHIPPING_COSTS.correo
// del checkout del frontend.
const CORREO_COST = 4400;
const CORREO_DAYS = '3-5 días hábiles';

/**
 * @desc    Cotiza el envío por código postal
 * @route   GET /api/shipping?postalCode=1406
 */
const getShippingQuote = (req, res) => {
  const postalCode = String(req.query.postalCode || '').trim();
  const digits = postalCode.replace(/\D/g, '');

  if (digits.length < 4 || digits.length > 8) {
    return res.status(400).json({
      success: false,
      message: 'Código postal inválido',
    });
  }

  return res.status(200).json({
    success: true,
    cost: CORREO_COST,
    days: CORREO_DAYS,
  });
};

// CORREO_COST se exporta para que el checkout valide contra la misma tarifa:
// una sola fuente de verdad del costo de envío en todo el backend.
module.exports = { getShippingQuote, CORREO_COST };
