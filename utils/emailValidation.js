// Largo máximo de un email según RFC 5321.
const MAX_EMAIL_LENGTH = 254;

// Las clases de caracteres de cada tramo son disjuntas (`[^\s@.]` excluye el
// punto que separa los tramos), así que el motor no puede retroceder de forma
// cuadrática ante entradas hostiles como "a@......". El tope de largo se chequea
// antes del regex: es lo que acota el costo en el peor caso.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const isValidEmail = (email) =>
  typeof email === 'string' && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);

module.exports = { isValidEmail, MAX_EMAIL_LENGTH };
