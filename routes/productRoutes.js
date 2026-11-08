const express = require('express');
const router = express.Router();
const {
  createProduct,
  getProducts,
  getAdminProducts,
  getCatalog,
  getProductById,
  updateProduct,
  deleteProduct,
} = require('../controllers/productController');
const { authMiddleware, adminMiddleware, optionalAuth } = require('../middleware/authMiddleware');
const { createRateLimit } = require('../middleware/rateLimit');
const { publicCache, noStore, NO_STALE_WHILE_REVALIDATE } = require('../middleware/httpCache');
const { validateBody } = require('../middleware/validateBody');
const { validateQuery } = require('../middleware/validateQuery');
const { adminProductListQuerySchema } = require('../schemas/adminProductListSchema');
const { catalogQuerySchema } = require('../schemas/catalogQuerySchema');
const { createProductSchema, updateProductSchema } = require('../schemas/productSchema');
const { validateProductIdParam } = require('../middleware/validateParams');

// Cabeceras de caché por ruta. Combinadas con el ETag de Express, las relecturas vuelven como 304 sin
// cuerpo y ni siquiera tocan la base. Los plazos son cortos a propósito: un cambio del admin (precio,
// stock) no puede tardar minutos en verse. Peor caso de atraso del stock que ve el comprador =
// max-age + TTL del servidor (20 s): /catalog 10 + 20 = 30 s, /:id 5 + 20 = 25 s. Sin stale-while-revalidate:
// con él se sumaban otros 30 s de copia vieja en navegador/CDN.
//  - listado general (`/`): se deja como estaba (10 s + SWR 30 s), no decide una compra.
//  - catálogo filtrado: 10 s sin SWR. Detalle: 5 s sin SWR (es donde se decide comprar).
const listCache = publicCache(10, 30);
const catalogCache = publicCache(10, NO_STALE_WHILE_REVALIDATE);
const detailCache = publicCache(5, NO_STALE_WHILE_REVALIDATE);

// Lecturas públicas: 10 req/s sostenidas por IP. El techo está puesto para
// frenar scraping y floods, no navegación normal ni una oficina detrás de un
// mismo NAT (la protección real ante picos es el bulkhead, no este límite).
const readLimit = createRateLimit({ name: 'products-read', windowMs: 60 * 1000, max: 600 });

// Catálogo filtrado: cada combinación de filtros es una clave de caché y, en frío, 2 consultas pesadas.
// Aparte del límite general, 120/min por IP (2/s sostenidos) alcanza para navegar y filtrar a mano.
const CATALOG_READ_LIMIT_PER_MINUTE = 120;
const catalogLimit = createRateLimit({
  name: 'products-catalog', windowMs: 60 * 1000, max: CATALOG_READ_LIMIT_PER_MINUTE,
});

// Escrituras de admin: mucho más caras (invalidan caché, tocan Cloudinary).
const writeLimit = createRateLimit({ name: 'products-write', windowMs: 60 * 1000, max: 60 });

// Listado del panel admin (filtros, orden y paginación en el servidor): lectura autenticada
// con su propio techo.
const adminReadLimit = createRateLimit({ name: 'products-admin-read', windowMs: 60 * 1000, max: 120 });

// Los ids de producto son bigint: cualquier otro formato es 400 antes de tocar la base.
router.param('id', validateProductIdParam);

// Lecturas públicas. `optionalAuth` solo identifica a un admin con token válido
// (ve también los productos inactivos); para el resto la request sigue anónima.
// Va ANTES de '/:id': si no, 'admin' se interpretaría como id de producto.
router.get(
  '/admin/list',
  adminReadLimit, noStore, authMiddleware, adminMiddleware,
  validateQuery(adminProductListQuerySchema), getAdminProducts
);
// Catálogo público filtrado (talle, color, orden). Anónimo a propósito: no pasa por `optionalAuth`, así
// que jamás incluye inactivos. Valida ANTES de `catalogCache` para que un 400 no quede cacheado
// públicamente. El caché HTTP (y su ETag) se separa por URL completa, query string incluido.
router.get('/catalog', readLimit, catalogLimit, validateQuery(catalogQuerySchema), catalogCache, getCatalog);
router.get('/', readLimit, listCache, optionalAuth, getProducts);
router.get('/:id', readLimit, detailCache, optionalAuth, getProductById);

// Protected routes (admin only)
router.post('/', writeLimit, noStore, authMiddleware, adminMiddleware, validateBody(createProductSchema), createProduct);
router.put('/:id', writeLimit, noStore, authMiddleware, adminMiddleware, validateBody(updateProductSchema), updateProduct);
router.delete('/:id', writeLimit, noStore, authMiddleware, adminMiddleware, deleteProduct);

module.exports = router;
