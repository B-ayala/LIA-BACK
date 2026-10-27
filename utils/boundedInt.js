/** Entero de query string acotado a [min, max]; `fallback` si no es un entero válido. */
const boundedInt = (raw, fallback, min, max) => {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

module.exports = { boundedInt };
