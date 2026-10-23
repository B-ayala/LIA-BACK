// Cliente mínimo de la Admin API de Cloudinary (Basic auth). Un solo lugar con
// timeout total y tope de respuesta: una llamada colgada retiene un slot del
// bulkhead, y una respuesta sin tope se acumula entera en memoria.

const https = require('https');

const CLOUDINARY_HOST = 'api.cloudinary.com';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/**
 * CLOUDINARY_API_SECRET tal como llega de la env var, saneado. Copiar/pegar el
 * secret en el panel de la plataforma puede sumar comillas o un salto de línea al
 * final sin que se note — eso invalida cualquier firma SHA1 calculada con él.
 */
const getApiSecret = () =>
  (process.env.CLOUDINARY_API_SECRET || '').trim().replace(/^['"]|['"]$/g, '');

const basicAuth = () =>
  Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${getApiSecret()}`).toString('base64');

/**
 * @param {string} method
 * @param {string} path
 * @param {{ body?: string, contentType?: string }} [options] body ya serializado
 * @returns {Promise<object>} JSON de la respuesta; rechaza por timeout, respuesta demasiado grande o JSON inválido.
 */
const cloudinaryRequest = (method, path, { body = null, contentType } = {}) =>
  new Promise((resolve, reject) => {
    const headers = { Authorization: `Basic ${basicAuth()}` };
    if (body) {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    // `signal` fija un plazo total; `request.setTimeout` solo mediría inactividad del socket.
    const request = https.request(
      { hostname: CLOUDINARY_HOST, path, method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      (response) => {
        const chunks = [];
        let received = 0;

        response.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            request.destroy(new Error('Respuesta de Cloudinary demasiado grande'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('Respuesta de Cloudinary no es JSON válido'));
          }
        });
      }
    );

    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });

module.exports = { cloudinaryRequest, getApiSecret };
