const express = require('express');
const router = express.Router();
const {
  loginUser,
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserByAuthId,
  signupStatus,
  signupRateLimit
} = require('../controllers/userController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { createRateLimit } = require('../middleware/rateLimit');
const { noStore } = require('../middleware/httpCache');

// Login: cada intento dispara una llamada a Supabase Auth + una query. Es el
// endpoint clásico de fuerza bruta, así que lleva el límite más estricto.
// Comparte el contador `auth-login` con POST /api/auth/login: con nombres distintos un atacante
// obtenía el doble de intentos por IP alternando entre los dos endpoints.
const loginLimit = createRateLimit({ name: 'auth-login', windowMs: 60 * 1000, max: 10 });

// Endpoints auxiliares del signup: se llaman en cada tecleo del formulario en
// algunos flujos, por eso un techo más alto pero acotado.
const signupLimit = createRateLimit({ name: 'users-signup', windowMs: 60 * 1000, max: 60 });

// Datos de usuarios: nunca cacheables (PII).
router.use(noStore);

// ─── Públicas (flujo de signup/login, pre-auth) ───
router.post('/login', loginLimit, loginUser);
router.get('/signup-status/:email', signupLimit, signupStatus);
router.post('/signup-ratelimit', signupLimit, signupRateLimit);

// ─── Protegidas (admin) ───
router.get('/auth/:userId', authMiddleware, adminMiddleware, getUserByAuthId);

router.route('/')
  .get(authMiddleware, adminMiddleware, getUsers)
  .post(authMiddleware, adminMiddleware, createUser);

router.route('/:id')
  .get(authMiddleware, adminMiddleware, getUserById)
  .put(authMiddleware, adminMiddleware, updateUser)
  .delete(authMiddleware, adminMiddleware, deleteUser);

module.exports = router;
