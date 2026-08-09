/**
 * Headers de seguridad HTTP.
 *
 * Se implementa acá en vez de sumar `helmet` porque esta API devuelve
 * exclusivamente JSON: de los ~15 headers de helmet solo aplican los de abajo,
 * y el resto (CSP para documentos HTML, políticas de embebido, etc.) no tiene
 * efecto sobre respuestas `application/json`. Evita una dependencia más en la
 * superficie de ataque para seis cabeceras.
 *
 * La CSP que protege al usuario final la define el frontend en `vercel.json`;
 * la de acá solo endurece el caso en que un navegador abra una URL de la API
 * directamente.
 */

const ONE_YEAR_SECONDS = 31536000;

const securityHeaders = (req, res, next) => {
  // Nada de esta API debe interpretarse como HTML ni ejecutarse en un navegador.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

  // Oculta que corre Express (no es seguridad real, pero no regala información).
  res.removeHeader('X-Powered-By');

  // HSTS solo tiene sentido servido sobre HTTPS. En desarrollo (http://localhost)
  // mandarlo dejaría el dominio "clavado" en HTTPS en el navegador del dev.
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', `max-age=${ONE_YEAR_SECONDS}; includeSubDomains`);
  }

  next();
};

module.exports = { securityHeaders };
