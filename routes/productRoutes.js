const express = require('express');
const router = express.Router();
const {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
} = require('../controllers/productController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { createRateLimit } = require('../middleware/rateLimit');
const { publicCache, noStore } = require('../middleware/httpCache');
const { validateBody } = require('../middleware/validateBody');
const { createProductSchema, updateProductSchema } = require('../schemas/productSchema');

// El catálogo es el endpoint más leído y el que menos cambia: se deja cachear
// 30 s en navegador/CDN. Combinado con el ETag de Express, las relecturas
// vuelven como 304 sin cuerpo y ni siquiera tocan la base.
const catalogCache = publicCache(30);

// Lecturas públicas: 10 req/s sostenidas por IP. El techo está puesto para
// frenar scraping y floods, no navegación normal ni una oficina detrás de un
// mismo NAT (la protección real ante picos es el bulkhead, no este límite).
const readLimit = createRateLimit({ name: 'products-read', windowMs: 60 * 1000, max: 600 });

// Escrituras de admin: mucho más caras (invalidan caché, tocan Cloudinary).
const writeLimit = createRateLimit({ name: 'products-write', windowMs: 60 * 1000, max: 60 });

// Public routes
router.get('/', readLimit, catalogCache, getProducts);
router.get('/:id', readLimit, catalogCache, getProductById);

// Protected routes (admin only)
router.post('/', writeLimit, noStore, authMiddleware, adminMiddleware, validateBody(createProductSchema), createProduct);
router.put('/:id', writeLimit, noStore, authMiddleware, adminMiddleware, validateBody(updateProductSchema), updateProduct);
router.delete('/:id', writeLimit, noStore, authMiddleware, adminMiddleware, deleteProduct);

module.exports = router;
