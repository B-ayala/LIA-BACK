const Product = require('../models/Product');
const { caches, TTL, invalidateProducts } = require('../utils/cache');
const logger = require('../utils/logger');
const { sendError } = require('../utils/httpResponses');
const { destroyCloudinaryImage } = require('../utils/cloudinaryDestroy');
const { resolveOriginalPrice } = require('../utils/productUpdateQuery');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
// Tope de `offset`: la clave de caché incluye el offset, así que uno sin cota
// permite llenar la caché con páginas vacías y expulsar las páginas reales.
const MAX_PAGE_OFFSET = 10000;

// Postgres rechaza un timestamp con forma válida pero fecha imposible (ej. mes 13).
const INVALID_DATETIME_CODES = new Set(['22007', '22008']);

const PRODUCT_NOT_FOUND_MESSAGE = 'Producto no encontrado';
const PRODUCT_CHANGED_MESSAGE =
  'El producto cambió desde que lo abriste (por ejemplo, por una compra). Recargalo y volvé a aplicar tus cambios.';

/**
 * Responde un error de servidor sin exponer internals: los errores de `pg` traen
 * detalle de infraestructura que va al log estructurado, no al cliente.
 */
const serverError = (res, action, error) => {
  logger.error(`products_${action}_failed`, { error: error.message, code: error.code });
  return sendError(res, 500, 'INTERNAL_ERROR', 'No se pudo completar la operación. Reintentá en unos segundos.');
};

/** Solo un admin autenticado (ver `optionalAuth`) ve productos no activos. */
const canSeeInactive = (req) => Boolean(req.user && req.user.role === 'admin');

/**
 * El catálogo cacheado se separa por audiencia: si admin y público compartieran
 * clave, el primero en llegar decidiría si el otro ve productos inactivos.
 */
const audienceOf = (includeInactive) => (includeInactive ? 'admin' : 'public');

/**
 * La respuesta depende del token: las cachés compartidas (CDN) deben variar por
 * `Authorization` y la versión de admin no puede quedar guardada en ninguna.
 */
const setAudienceHeaders = (res, includeInactive) => {
  res.vary('Authorization');
  if (includeInactive) res.setHeader('Cache-Control', 'private, no-store');
};

/** Entero saneado dentro de [min, max]; cae al default si no es válido. */
const boundedInt = (raw, fallback, min, max) => {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};

/** Valores del INSERT de un producto (el body ya lo validó el schema Zod de la ruta). */
const toInsertValues = (body) => {
  const { images, imageUrl } = body;
  return [
    body.name,
    Number.parseFloat(body.price),
    body.stock || 0,
    body.category || null,
    images && images.length > 0 ? images[0] : (imageUrl || ''),
    body.publicId || '',
    body.description || null,
    body.discount ? Number.parseFloat(body.discount) : null,
    body.condition || 'new',
    body.freeShipping || false,
    body.hoverImageEnabled !== undefined ? body.hoverImageEnabled : true,
    body.variants ? JSON.stringify(body.variants) : null,
    body.specifications ? JSON.stringify(body.specifications) : null,
    body.features ? JSON.stringify(body.features) : null,
    body.faqs ? JSON.stringify(body.faqs) : null,
    body.warranty || null,
    body.returnPolicy || null,
    body.sizeGuide ? JSON.stringify(body.sizeGuide) : null,
    body.status || 'active',
    images ? JSON.stringify(images) : null,
    resolveOriginalPrice(body.originalPrice, body.price),
    body.cardOptions ? JSON.stringify(body.cardOptions) : null,
  ];
};

// Un producto "Activo" sin stock es un estado válido: se muestra en la tienda
// marcado "Sin stock" y no se puede comprar (el front pide confirmación antes).
const createProduct = async (req, res) => {
  try {
    const product = await Product.create(toInsertValues(req.body), req.user.id);
    invalidateProducts();
    return res.status(201).json({ success: true, data: product });
  } catch (error) {
    return serverError(res, 'create', error);
  }
};

const getProducts = async (req, res) => {
  try {
    const limit = boundedInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = boundedInt(req.query.offset, 0, 0, MAX_PAGE_OFFSET);
    const includeInactive = canSeeInactive(req);
    setAudienceHeaders(res, includeInactive);

    // Caché + single-flight: una ráfaga de lecturas de la misma página ejecuta una
    // sola query. Se invalida ante cualquier cambio de producto o de stock.
    const { rows, total } = await caches.products.getOrSet(
      `list:${audienceOf(includeInactive)}:${limit}:${offset}`,
      TTL.products,
      () => Product.findPage(limit, offset, includeInactive)
    );
    return res.json({
      success: true, data: rows, count: rows.length, total, limit, offset, hasMore: offset + rows.length < total,
    });
  } catch (error) {
    return serverError(res, 'list', error);
  }
};

const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const includeInactive = canSeeInactive(req);
    setAudienceHeaders(res, includeInactive);

    // "No existe" se recuerda en una caché aparte y chica: un scraper de ids inexistentes
    // no golpea la BD, pero tampoco expulsa los productos reales de la caché del catálogo.
    // Un producto inactivo es "no existe" para el público, no solo "oculto".
    const cacheKey = `detail:${audienceOf(includeInactive)}:${id}`;
    if (caches.productMisses.get(cacheKey)) return sendError(res, 404, 'PRODUCT_NOT_FOUND', PRODUCT_NOT_FOUND_MESSAGE);

    const product = await caches.products.getOrSet(
      cacheKey,
      TTL.products,
      () => Product.findById(id, includeInactive),
      { isCacheable: (value) => value !== null }
    );
    if (!product) {
      caches.productMisses.set(cacheKey, true, TTL.products);
      return sendError(res, 404, 'PRODUCT_NOT_FOUND', PRODUCT_NOT_FOUND_MESSAGE);
    }
    return res.json({ success: true, data: product });
  } catch (error) {
    return serverError(res, 'detail', error);
  }
};

const UPDATE_FAILURES = {
  empty: [400, 'NO_FIELDS', 'No hay campos para actualizar'],
  not_found: [404, 'PRODUCT_NOT_FOUND', PRODUCT_NOT_FOUND_MESSAGE],
  changed: [409, 'PRODUCT_CHANGED', PRODUCT_CHANGED_MESSAGE],
};

/**
 * `expectedUpdatedAt` (opcional): `updated_at` tal como lo leyó el admin. Si el
 * producto cambió desde entonces (ej. una compra descontó stock) → 409 sin tocar nada.
 */
const updateProduct = async (req, res) => {
  try {
    const { expectedUpdatedAt, ...fields } = req.body;
    const result = await Product.update(req.params.id, fields, expectedUpdatedAt, req.user.id);
    if (result.status !== 'updated') {
      const [status, code, message] = UPDATE_FAILURES[result.status];
      return sendError(res, status, code, message);
    }
    invalidateProducts();
    return res.json({ success: true, data: result.product });
  } catch (error) {
    if (INVALID_DATETIME_CODES.has(error.code)) {
      return sendError(res, 400, 'VALIDATION_ERROR', 'La fecha de última modificación no es válida.');
    }
    return serverError(res, 'update', error);
  }
};

/** No borrar el asset si otro producto, el carrusel o el contenido del sitio lo usan (Cloudinary borra por public_id). */
const removeProductImage = async ({ publicId, imageInUse }) => {
  if (!publicId) return;
  if (imageInUse) {
    logger.warn('cloudinary_asset_in_use', { publicId });
    return;
  }
  try {
    await destroyCloudinaryImage(publicId);
  } catch (error) {
    // El producto ya se borró: un asset huérfano en Cloudinary no debe fallar la operación.
    logger.warn('cloudinary_delete_failed', { error: error.message });
  }
};

const deleteProduct = async (req, res) => {
  try {
    const result = await Product.deleteIfNoPendingOrders(req.params.id, req.user.id);
    if (result.status === 'not_found') return sendError(res, 404, 'PRODUCT_NOT_FOUND', PRODUCT_NOT_FOUND_MESSAGE);
    if (result.status === 'has_pending_orders') {
      return sendError(res, 409, 'PRODUCT_HAS_PENDING_ORDERS',
        'El producto tiene compras pendientes de pago. Esperá a que se paguen, cancelen o expiren antes de eliminarlo.');
    }
    invalidateProducts();
    await removeProductImage(result);
    return res.json({ success: true, message: 'Producto eliminado exitosamente' });
  } catch (error) {
    return serverError(res, 'delete', error);
  }
};

module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
};
