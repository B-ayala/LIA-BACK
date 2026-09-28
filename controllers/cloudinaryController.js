const crypto = require('crypto');
const https = require('https');
const logger = require('../utils/logger');

/**
 * Responde un error de servidor sin exponer internals (respuesta cruda de
 * Cloudinary, mensajes de red, etc.). El detalle real va al log estructurado.
 */
const serverError = (res, action, error) => {
  logger.error(`cloudinary_${action}_failed`, { error: error.message });
  return res.status(502).json({
    success: false,
    code: 'CLOUDINARY_ERROR',
    message: 'No se pudo completar la operación con Cloudinary. Reintentá en unos segundos.',
  });
};

/**
 * Un segmento de carpeta válido para la API de Cloudinary: sin `..`, sin `/`
 * dentro del segmento, sin vacíos. Rechaza cualquier intento de escapar del
 * namespace de carpetas (ej. `productos/../../otra-cuenta`).
 */
const FOLDER_SEGMENT_RE = /^[A-Za-z0-9 _-]+$/;

/**
 * CLOUDINARY_API_SECRET tal como llega de la env var, saneado. Copiar/pegar el
 * secret en el panel de Railway puede sumar comillas o un salto de línea al
 * final sin que se note — eso invalida cualquier firma SHA1 calculada con él.
 */
const getApiSecret = () =>
  (process.env.CLOUDINARY_API_SECRET || '').trim().replace(/^['"]|['"]$/g, '');

/** @returns {string[]|null} segmentos saneados, o null si el path es inválido. */
const sanitizeFolderPath = (rawPath) => {
  const segments = String(rawPath).split('/');
  const isValid = segments.every((segment) => segment !== '..' && FOLDER_SEGMENT_RE.test(segment));
  return isValid ? segments : null;
};

const generateSignature = (req, res) => {
  try {
    // Widget sends the exact params it wants to sign in the request body
    // e.g. { folder: 'productos', timestamp: 1234567890, upload_preset: 'Liastore', source: 'uw', ... }
    const paramsToSign = req.body;

    if (!paramsToSign || Object.keys(paramsToSign).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No se proporcionaron parámetros para firmar',
      });
    }

    // Cloudinary signature: sort keys alphabetically, concatenate "key=value&...", append API_SECRET
    const apiSecret = getApiSecret();
    const signatureString =
      Object.keys(paramsToSign)
        .sort()
        .map((key) => `${key}=${paramsToSign[key]}`)
        .join('&') + apiSecret;

    // SHA1 hash
    const signature = crypto
      .createHash('sha1')
      .update(signatureString)
      .digest('hex');

    res.json({
      success: true,
      data: {
        signature,
      },
    });
  } catch (error) {
    serverError(res, 'generate_signature', error);
  }
};

const deleteImage = async (req, res) => {
  try {
    const { publicId } = req.body;

    if (!publicId) {
      return res.status(400).json({
        success: false,
        message: 'El publicId es requerido',
      });
    }

    // Create auth string for Cloudinary API
    const apiSecret = getApiSecret();
    const auth = Buffer.from(
      `${process.env.CLOUDINARY_API_KEY}:${apiSecret}`
    ).toString('base64');

    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/image/upload?public_ids%5B%5D=${encodeURIComponent(publicId)}`,
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    };

    const request = https.request(options, (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        try {
          const result = JSON.parse(data);
          res.json({
            success: true,
            data: result,
          });
        } catch (parseError) {
          serverError(res, 'delete_image_parse', parseError);
        }
      });
    });

    request.on('error', (error) => serverError(res, 'delete_image', error));

    request.end();
  } catch (error) {
    serverError(res, 'delete_image', error);
  }
};

const getImages = async (req, res) => {
  try {
    const { folder, next_cursor } = req.query;

    const apiSecret = getApiSecret();
    const auth = Buffer.from(
      `${process.env.CLOUDINARY_API_KEY}:${apiSecret}`
    ).toString('base64');

    let path = `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/image?max_results=100&type=upload`;
    if (folder) path += `&prefix=${encodeURIComponent(folder)}`;
    if (next_cursor) path += `&next_cursor=${encodeURIComponent(next_cursor)}`;

    const options = {
      hostname: 'api.cloudinary.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
      },
    };

    const request = https.request(options, (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        try {
          const result = JSON.parse(data);
          // Cloudinary responde 200 con { error } ante credenciales/permisos inválidos:
          // propagarlo como error real para que el front muestre estado de error y no crashee.
          if (result.error || !Array.isArray(result.resources)) {
            return res.status(502).json({
              success: false,
              message: result.error?.message || 'Respuesta inválida de Cloudinary',
            });
          }
          res.json({ success: true, data: result });
        } catch (parseError) {
          serverError(res, 'get_images_parse', parseError);
        }
      });
    });

    request.on('error', (error) => serverError(res, 'get_images', error));

    request.end();
  } catch (error) {
    serverError(res, 'get_images', error);
  }
};

// Map Cloudinary Admin API /usage response to the shape the frontend expects.
// El plan free se mide en CRÉDITOS mensuales (credits.usage/limit), no en cantidad
// de archivos. asset_count es solo informativo (cantidad de recursos almacenados).
const mapUsageResponse = (result) => ({
  credits_used: result.credits?.usage ?? 0,
  credits_limit: result.credits?.limit ?? 0,
  credits_used_percent: result.credits?.used_percent ?? 0,
  asset_count: result.resources ?? result.objects?.usage ?? 0,
});

const getUsage = async (_req, res) => {
  try {
    const apiPath = `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/usage`;
    const result = await cloudinaryRequest('GET', apiPath, null);

    if (result.error) {
      return res.status(502).json({
        success: false,
        message: result.error.message || 'Cloudinary devolvió un error de uso',
      });
    }

    res.json({ success: true, data: mapUsageResponse(result) });
  } catch (error) {
    serverError(res, 'get_usage', error);
  }
};

// Helper: make a Cloudinary Admin API request
const cloudinaryRequest = (method, path, body) => {
  return new Promise((resolve, reject) => {
    const apiSecret = getApiSecret();
    const auth = Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${apiSecret}`).toString('base64');

    const headers = { 'Authorization': `Basic ${auth}` };
    let postData = null;

    if (body) {
      postData = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(
      { hostname: 'api.cloudinary.com', path, method, headers },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Parse error')); }
        });
      }
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
};

const getFolders = async (req, res) => {
  try {
    const { path: folderPath } = req.query;
    let apiPath = `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/folders`;

    if (folderPath) {
      const segments = sanitizeFolderPath(folderPath);
      if (!segments) {
        return res.status(400).json({ success: false, message: 'El path de la carpeta no es válido' });
      }
      apiPath += `/${segments.map(encodeURIComponent).join('/')}`;
    }

    const result = await cloudinaryRequest('GET', apiPath, null);
    res.json({ success: true, data: result });
  } catch (error) {
    serverError(res, 'get_folders', error);
  }
};

const createFolder = async (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) {
      return res.status(400).json({ success: false, message: 'El path de la carpeta es requerido' });
    }
    const segments = sanitizeFolderPath(folderPath);
    if (!segments) {
      return res.status(400).json({ success: false, message: 'El path de la carpeta no es válido' });
    }

    const apiPath = `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/folders/${segments.map(encodeURIComponent).join('/')}`;
    const result = await cloudinaryRequest('POST', apiPath, null);
    res.json({ success: true, data: result });
  } catch (error) {
    serverError(res, 'create_folder', error);
  }
};

const deleteFolder = async (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) {
      return res.status(400).json({ success: false, message: 'El path de la carpeta es requerido' });
    }
    const segments = sanitizeFolderPath(folderPath);
    if (!segments) {
      return res.status(400).json({ success: false, message: 'El path de la carpeta no es válido' });
    }

    const apiPath = `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/folders/${segments.map(encodeURIComponent).join('/')}`;
    const result = await cloudinaryRequest('DELETE', apiPath, null);
    res.json({ success: true, data: result });
  } catch (error) {
    serverError(res, 'delete_folder', error);
  }
};

const getConfig = (_req, res) => {
  res.json({
    success: true,
    data: {
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
    },
  });
};

module.exports = { generateSignature, deleteImage, getImages, getUsage, getConfig, getFolders, createFolder, deleteFolder };
