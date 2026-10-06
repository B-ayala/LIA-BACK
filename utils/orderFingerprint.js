const crypto = require('crypto');

const HASH_LENGTH = 12;

/** JSON con claves ordenadas: el mismo contenido siempre produce el mismo texto. */
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const canonicalLine = (item) =>
  stableStringify({
    p: Number.parseInt(item.productId, 10),
    q: item.quantity,
    u: item.unitsConfig || [],
  });

/**
 * Huella corta (12 hex, sin ':') de lo que el comprador pide: productos, cantidades,
 * variantes, envío y medio de pago. Dos pedidos iguales dan la misma huella aunque el
 * carrito llegue en otro orden; sirve para detectar una Idempotency-Key reutilizada
 * con un carrito distinto. No incluye precios: los fija el servidor.
 */
const orderFingerprint = ({ items, shippingMethod, paymentMethod }) => {
  const lines = items.map(canonicalLine).sort();
  const canonical = stableStringify({ lines, shippingMethod: shippingMethod || null, paymentMethod });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, HASH_LENGTH);
};

module.exports = { orderFingerprint };
