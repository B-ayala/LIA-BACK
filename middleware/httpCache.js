/**
 * Cabeceras de caché HTTP.
 *
 * Es la capa de carga más barata que existe: con `Cache-Control` + `ETag` (que
 * Express calcula solo sobre el body JSON), un catálogo que no cambió se
 * responde con **304 sin cuerpo** y el navegador/CDN absorbe la mayoría de las
 * lecturas repetidas antes de llegar al backend.
 *
 * `stale-while-revalidate` permite servir la copia vieja mientras se revalida:
 * evita el pico de tráfico sincronizado cuando expira la caché, a costa de que el stock mostrado
 * pueda atrasarse `max-age + swr` más. Por eso las rutas donde el stock decide la compra (detalle y
 * catálogo filtrado) lo desactivan con `NO_STALE_WHILE_REVALIDATE`.
 */

/** Valor de `staleWhileRevalidateSeconds` para no emitir la directiva. */
const NO_STALE_WHILE_REVALIDATE = 0;

/** Recursos públicos de baja volatilidad (catálogo). */
const publicCache = (maxAgeSeconds, staleWhileRevalidateSeconds = maxAgeSeconds * 3) => (_req, res, next) => {
  const swr = staleWhileRevalidateSeconds > 0 ? `, stale-while-revalidate=${staleWhileRevalidateSeconds}` : '';
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}${swr}`);
  next();
};

/** Datos por usuario o de administración: nunca en cachés compartidas. */
const noStore = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

module.exports = { publicCache, noStore, NO_STALE_WHILE_REVALIDATE };
