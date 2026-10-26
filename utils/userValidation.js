// Reglas del nombre de usuario. Mismas que `FRONT/.../utils/validation.ts` y que el
// trigger `handle_new_user` (db/migrations/2026-10-25_signup_input_validation.sql):
// si cambian acá, cambian en los tres lugares.
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 60;

// Letras de cualquier idioma (con tildes/ñ), espacios, apóstrofe, punto y guion.
// Tiene que empezar con una letra. Las clases no se superponen: sin backtracking
// cuadrático; el tope de largo se chequea antes del regex.
const NAME_PATTERN = /^\p{L}[\p{L}\p{M}' .-]*$/u;

const isValidUserName = (name) =>
  typeof name === 'string' &&
  name.trim().length >= NAME_MIN_LENGTH &&
  name.trim().length <= NAME_MAX_LENGTH &&
  NAME_PATTERN.test(name.trim());

const INVALID_USER_NAME_MESSAGE =
  `El nombre debe tener entre ${NAME_MIN_LENGTH} y ${NAME_MAX_LENGTH} caracteres y solo puede contener letras, espacios, apóstrofes, puntos y guiones`;

module.exports = { isValidUserName, INVALID_USER_NAME_MESSAGE, NAME_MIN_LENGTH, NAME_MAX_LENGTH };
