const express = require('express');
const router = express.Router();
const { login, refresh, logout, resendConfirmation, forgotPassword } = require('../controllers/authController');
const { createRateLimit } = require('../middleware/rateLimit');
const { noStore } = require('../middleware/httpCache');

// Credenciales de sesión: nunca cacheables.
router.use(noStore);

// Mismo límite que el login histórico de /api/users/login: es el endpoint
// clásico de fuerza bruta.
const loginLimit = createRateLimit({ name: 'auth-login', windowMs: 60 * 1000, max: 10 });

// El refresh se dispara solo (timer proactivo en el frontend, más el arranque
// de cada pestaña), no lo escribe un humano: techo más alto pero acotado para
// no dejarlo abierto a abuso si alguien scriptea contra el endpoint.
const refreshLimit = createRateLimit({ name: 'auth-refresh', windowMs: 60 * 1000, max: 30 });

const logoutLimit = createRateLimit({ name: 'auth-logout', windowMs: 60 * 1000, max: 20 });

// Límite por IP como defensa adicional; el límite real (3 cada 24hs) es por
// email y vive en emailActionLimiter, aplicado dentro del controller.
const resendConfirmationLimit = createRateLimit({ name: 'auth-resend-confirmation', windowMs: 5 * 60 * 1000, max: 10 });
const forgotPasswordLimit = createRateLimit({ name: 'auth-forgot-password', windowMs: 5 * 60 * 1000, max: 10 });

router.post('/login', loginLimit, login);
router.post('/refresh', refreshLimit, refresh);
router.post('/logout', logoutLimit, logout);
router.post('/resend-confirmation', resendConfirmationLimit, resendConfirmation);
router.post('/forgot-password', forgotPasswordLimit, forgotPassword);

module.exports = router;
