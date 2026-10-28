/**
 * Versión vigente de los Términos antes de que el admin edite los suyos desde el panel.
 * Debe coincidir con DEFAULT_TERMS_VERSION del frontend (src/users/pages/legal/termsVersion.ts).
 */
const DEFAULT_TERMS_VERSION = '2026-10-28';

// Mismo formato que acepta el CHECK de `terms_acceptances.terms_version` (1–40 caracteres).
const TERMS_VERSION_PATTERN = /^[\w.-]{1,40}$/;

const isValidTermsVersion = (value) => typeof value === 'string' && TERMS_VERSION_PATTERN.test(value);

module.exports = { DEFAULT_TERMS_VERSION, TERMS_VERSION_PATTERN, isValidTermsVersion };
