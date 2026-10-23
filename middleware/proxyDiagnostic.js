// Diagnóstico de `trust proxy` (A5): el rate limit usa `req.ip`, y con
// `trust proxy = 1` solo es correcto si hay UN proxy delante del backend. Si hay
// más saltos (por ejemplo Cloudflare + el balanceador de Render), `req.ip` sería
// la IP de un proxy y todos los usuarios compartirían el mismo cupo.
//
// Loguea las primeras requests de cada arranque con la cantidad de saltos de
// `X-Forwarded-For` y la IP enmascarada (nunca completa: es dato personal).
// Solo observa: no cambia ningún comportamiento.

const logger = require('../utils/logger');

const SAMPLES_PER_BOOT = 3;
const IPV4_KEPT_OCTETS = 2;
const IPV6_KEPT_GROUPS = 2;

const maskIp = (ip) => {
  if (!ip) return null;
  if (ip.includes('.')) {
    const octets = ip.replace(/^::ffff:/, '').split('.');
    return `${octets.slice(0, IPV4_KEPT_OCTETS).join('.')}.x.x`;
  }
  return `${ip.split(':').slice(0, IPV6_KEPT_GROUPS).join(':')}::x`;
};

const splitForwardedFor = (header) =>
  String(header || '').split(',').map((hop) => hop.trim()).filter(Boolean);

let remaining = SAMPLES_PER_BOOT;

const proxyDiagnostic = (req, _res, next) => {
  const hops = splitForwardedFor(req.headers['x-forwarded-for']);
  if (remaining > 0 && hops.length > 0) {
    remaining -= 1;
    logger.info('proxy_diagnostic', {
      forwardedForHops: hops.length,
      reqIp: maskIp(req.ip),
      reqIpIsRightmostHop: req.ip === hops[hops.length - 1],
      reqIpIsLeftmostHop: req.ip === hops[0],
      viaCloudflare: Boolean(req.headers['cf-ray']),
      trustProxy: req.app.get('trust proxy'),
    });
  }
  next();
};

module.exports = { proxyDiagnostic, maskIp };
