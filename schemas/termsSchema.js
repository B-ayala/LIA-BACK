const { z } = require('zod');
const { isValidEmail, MAX_EMAIL_LENGTH } = require('../utils/emailValidation');
const { isValidTermsVersion } = require('../utils/termsVersion');

const termsVersionSchema = z.string().refine(isValidTermsVersion, 'Versión de términos inválida');

const emailSchema = z.string().trim().toLowerCase()
  .max(MAX_EMAIL_LENGTH, 'El email es demasiado largo')
  .refine(isValidEmail, 'Ingresá un email válido');

const acceptTermsSchema = z.strictObject({ termsVersion: termsVersionSchema });

const registrationAcceptanceSchema = z.strictObject({ email: emailSchema, termsVersion: termsVersionSchema });

module.exports = { acceptTermsSchema, registrationAcceptanceSchema };
