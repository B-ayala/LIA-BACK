const TermsAcceptance = require('../models/TermsAcceptance');
const logger = require('../utils/logger');
const { sendError } = require('../utils/httpResponses');

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_CONFLICT = 409;

/**
 * @desc    Versión vigente de los Términos y si el usuario ya la aceptó.
 * @route   GET /api/terms/status
 */
const getTermsStatus = async (req, res) => {
  try {
    const status = await TermsAcceptance.statusFor(req.user);
    return res.status(200).json({ success: true, ...status });
  } catch (error) {
    logger.error('terms_status_failed', { code: error.code, message: error.message });
    return sendError(res, 500, 'INTERNAL_ERROR', 'No pudimos verificar los términos. Intentá de nuevo.');
  }
};

/**
 * @desc    Registra que el usuario aceptó la versión vigente (cuentas anteriores al tilde del registro, o
 *          cambio de versión). Solo se acepta la vigente: el cliente no puede dejar constancia de otra.
 * @route   POST /api/terms/accept
 */
const acceptTerms = async (req, res) => {
  try {
    const currentVersion = await TermsAcceptance.currentVersion();
    if (req.body.termsVersion !== currentVersion) {
      return sendError(
        res, HTTP_CONFLICT, 'TERMS_VERSION_OUTDATED',
        'Los términos cambiaron mientras estabas en la página. Revisalos y aceptá de nuevo.',
        { currentVersion }
      );
    }
    await TermsAcceptance.record({
      userId: req.user.id,
      buyerEmail: req.user.email,
      termsVersion: currentVersion,
      ip: req.ip,
      context: TermsAcceptance.CONTEXT.REACCEPTANCE,
    });
    return res.status(HTTP_CREATED).json({ success: true, currentVersion, accepted: true });
  } catch (error) {
    logger.error('terms_accept_failed', { userId: req.user.id, code: error.code, message: error.message });
    return sendError(res, 500, 'INTERNAL_ERROR', 'No pudimos registrar tu aceptación. Intentá de nuevo.');
  }
};

/**
 * @desc    Constancia (con IP) de que quien se registra tildó los Términos. Es pública porque todavía no hay
 *          sesión; por eso es solo evidencia: nunca habilita una compra (eso lo decide la versión guardada
 *          en la cuenta, que no se puede falsificar a nombre de otra persona). Responde igual aunque no
 *          registre nada, para no revelar qué versión rige ni si un email existe.
 * @route   POST /api/terms/registration
 */
const recordRegistrationAcceptance = async (req, res) => {
  try {
    const currentVersion = await TermsAcceptance.currentVersion();
    if (req.body.termsVersion === currentVersion) {
      await TermsAcceptance.record({
        userId: null,
        buyerEmail: req.body.email,
        termsVersion: currentVersion,
        ip: req.ip,
        context: TermsAcceptance.CONTEXT.REGISTRATION,
      });
    }
  } catch (error) {
    logger.error('terms_registration_not_saved', { code: error.code, message: error.message });
  }
  return res.status(HTTP_NO_CONTENT).end();
};

module.exports = { getTermsStatus, acceptTerms, recordRegistrationAcceptance };
