const express = require('express');
const router = express.Router();
const { getSizes, createSize, updateSize } = require('../controllers/sizeController');
const { authMiddleware, adminMiddleware, optionalAuth } = require('../middleware/authMiddleware');
const { createRateLimit } = require('../middleware/rateLimit');
const { publicCache, noStore } = require('../middleware/httpCache');
const { validateBody } = require('../middleware/validateBody');
const { createSizeSchema, updateSizeSchema } = require('../schemas/sizeSchema');
const { validateSizeIdParam } = require('../middleware/validateParams');

// Mismo criterio que el catálogo de productos: lectura pública cacheable 30 s.
const catalogCache = publicCache(30);

const readLimit = createRateLimit({ name: 'sizes-read', windowMs: 60 * 1000, max: 600 });
const writeLimit = createRateLimit({ name: 'sizes-write', windowMs: 60 * 1000, max: 60 });

router.param('id', validateSizeIdParam);

router.get('/', readLimit, catalogCache, optionalAuth, getSizes);

// Los talles no se borran: se desactivan con PUT { active: false }.
router.post('/', writeLimit, noStore, authMiddleware, adminMiddleware, validateBody(createSizeSchema), createSize);
router.put('/:id', writeLimit, noStore, authMiddleware, adminMiddleware, validateBody(updateSizeSchema), updateSize);

module.exports = router;
