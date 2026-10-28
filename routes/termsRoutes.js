const express = require('express');
const router = express.Router();
const { getTermsStatus, acceptTerms, recordRegistrationAcceptance } = require('../controllers/termsController');
const { authMiddleware } = require('../middleware/authMiddleware');
const { createRateLimit } = require('../middleware/rateLimit');
const { noStore } = require('../middleware/httpCache');
const { validateBody } = require('../middleware/validateBody');
const { acceptTermsSchema, registrationAcceptanceSchema } = require('../schemas/termsSchema');

// Público y sin sesión: se acota por IP. Una persona se registra pocas veces; un script no debe llenar la tabla.
const registrationIpLimit = createRateLimit({ name: 'terms-registration-ip', windowMs: 10 * 60 * 1000, max: 20 });

const userLimit = createRateLimit({ name: 'terms-user', windowMs: 60 * 1000, max: 60 });

router.use(noStore);

router.post('/registration', registrationIpLimit, validateBody(registrationAcceptanceSchema), recordRegistrationAcceptance);

router.get('/status', userLimit, authMiddleware, getTermsStatus);
router.post('/accept', userLimit, authMiddleware, validateBody(acceptTermsSchema), acceptTerms);

module.exports = router;
