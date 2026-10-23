const crypto = require('crypto');
const logger = require('../utils/logger');
const { cloudinaryRequest, getApiSecret } = require('../utils/cloudinaryHttp');

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

    const result = await cloudinaryRequest(
      'DELETE',
      `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/image/upload?public_ids%5B%5D=${encodeURIComponent(publicId)}`
    );
    res.json({ success: true, data: result });
  } catch (error) {
    serverError(res, 'delete_image', error);
  }
};

const getImages = async (req, res) => {
  try {
    const { folder, next_cursor } = req.query;

    let path = `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/image?max_results=100&type=upload`;
    if (folder) path += `&prefix=${encodeURIComponent(folder)}`;
    if (next_cursor) path += `&next_cursor=${encodeURIComponent(next_cursor)}`;

    const result = await cloudinaryRequest('GET', path);
    // Cloudinary responde 200 con { error } ante credenciales/permisos inválidos:
    // propagarlo como error real para que el front muestre estado de error y no crashee.
    if (result.error || !Array.isArray(result.resources)) {
      return res.status(502).json({
        success: false,
        message: result.error?.message || 'Respuesta inválida de Cloudinary',
      });
    }
    res.json({ success: true, data: result });
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
    const result = await cloudinaryRequest('GET', apiPath);

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

    const result = await cloudinaryRequest('GET', apiPath);
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
    const result = await cloudinaryRequest('POST', apiPath);
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
    const result = await cloudinaryRequest('DELETE', apiPath);
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
