const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { createWithdrawal, listWithdrawals, updateWithdrawal } = require('../controllers/withdrawalController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { createRateLimit } = require('../middleware/rateLimit');
const { noStore } = require('../middleware/httpCache');
const { validateBody } = require('../middleware/validateBody');
const { validateWithdrawalIdParam } = require('../middleware/validateParams');
const { createWithdrawalSchema, updateWithdrawalSchema } = require('../schemas/withdrawalSchema');

// Endpoint público y sin login (lo exige la norma): el abuso se frena por IP y por email.
// La ventana larga es holgada para una persona (arrepentirse de varias compras) y cortante para un script.
const createIpLimit = createRateLimit({ name: 'withdrawals-create-ip', windowMs: 10 * 60 * 1000, max: 10 });

// La clave lleva el hash del email, no el email: el límite loguea su clave al bloquear y no debe filtrar PII.
const emailKey = (req) => `email:${crypto.createHash('sha256').update(req.body.email).digest('hex').slice(0, 16)}`;
const createEmailLimit = createRateLimit({
  name: 'withdrawals-create-email', windowMs: 60 * 60 * 1000, max: 5, keyGenerator: emailKey,
});

const adminLimit = createRateLimit({ name: 'withdrawals-admin', windowMs: 60 * 1000, max: 120 });

// Contienen datos personales: ninguna respuesta es cacheable.
router.use(noStore);
router.param('id', validateWithdrawalIdParam);

router.post('/', createIpLimit, validateBody(createWithdrawalSchema), createEmailLimit, createWithdrawal);

router.get('/', adminLimit, authMiddleware, adminMiddleware, listWithdrawals);
router.patch(
  '/:id', adminLimit, authMiddleware, adminMiddleware, validateBody(updateWithdrawalSchema), updateWithdrawal
);

module.exports = router;
