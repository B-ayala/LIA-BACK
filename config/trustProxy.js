// Cantidad de proxies de confianza delante del backend (Express `trust proxy`).
// Se cuenta desde la derecha de X-Forwarded-For: lo que el cliente agregue a la
// izquierda no cuenta, por eso un número fijo es más seguro que confiar en la cabecera.
const DEFAULT_TRUST_PROXY_HOPS = 1;
const MAX_TRUST_PROXY_HOPS = 5;

const resolveTrustProxyHops = (raw) => {
  const hops = Number.parseInt(raw, 10);
  return Number.isInteger(hops) && hops >= 1 && hops <= MAX_TRUST_PROXY_HOPS ? hops : DEFAULT_TRUST_PROXY_HOPS;
};

module.exports = { resolveTrustProxyHops };
