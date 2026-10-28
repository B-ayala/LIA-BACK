const { pool } = require('../config/database');
const { DEFAULT_TERMS_VERSION, isValidTermsVersion } = require('../utils/termsVersion');

const CONTEXT = Object.freeze({ CHECKOUT: 'checkout', REGISTRATION: 'registration', REACCEPTANCE: 'reacceptance' });

const TERMS_CONTENT_KEY = 'legal_terms';

/** Constancia de qué versión de los Términos aceptó cada persona (tabla public.terms_acceptances). */
class TermsAcceptance {
  /**
   * Versión vigente: la que el admin publicó en `site_content` (clave `legal_terms`). Si todavía no
   * editó los Términos, o el valor guardado no tiene un formato válido, rige la versión por defecto.
   */
  static async currentVersion() {
    const { rows } = await pool.query(
      `SELECT value->>'version' AS version
         FROM public.site_content
        WHERE key = $1
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [TERMS_CONTENT_KEY]
    );
    const published = rows[0] && rows[0].version;
    return isValidTermsVersion(published) ? published : DEFAULT_TERMS_VERSION;
  }

  static async hasAccepted(userId, termsVersion) {
    const { rows } = await pool.query(
      'SELECT 1 FROM public.terms_acceptances WHERE user_id = $1 AND terms_version = $2 LIMIT 1',
      [userId, termsVersion]
    );
    return rows.length > 0;
  }

  /**
   * ¿Esta persona aceptó la versión vigente? Vale haberla aceptado al crear la cuenta (la versión viaja
   * en los metadatos del usuario de Supabase) o en una constancia posterior.
   */
  static async statusFor(user) {
    const currentVersion = await TermsAcceptance.currentVersion();
    const accepted = user.termsVersion === currentVersion
      || await TermsAcceptance.hasAccepted(user.id, currentVersion);
    return { currentVersion, accepted };
  }

  static async record({ userId, buyerEmail, orderNumber, termsVersion, ip, context = CONTEXT.CHECKOUT }) {
    await pool.query(
      `INSERT INTO public.terms_acceptances (user_id, buyer_email, order_number, terms_version, ip, context)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId ?? null, buyerEmail, orderNumber ?? null, termsVersion, ip ?? null, context]
    );
  }
}

TermsAcceptance.CONTEXT = CONTEXT;

module.exports = TermsAcceptance;
