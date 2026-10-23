const express = require('express');
const router = express.Router();
const {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserByAuthId
} = require('../controllers/userController');
const { authMiddleware, adminMiddleware } = require('../middleware/authMiddleware');
const { noStore } = require('../middleware/httpCache');

// Datos de usuarios: nunca cacheables (PII).
router.use(noStore);

// Todas las rutas son de admin. El login/registro público vive en /api/auth y en Supabase Auth.
router.get('/auth/:userId', authMiddleware, adminMiddleware, getUserByAuthId);

router.route('/')
  .get(authMiddleware, adminMiddleware, getUsers)
  .post(authMiddleware, adminMiddleware, createUser);

router.route('/:id')
  .get(authMiddleware, adminMiddleware, getUserById)
  .put(authMiddleware, adminMiddleware, updateUser)
  .delete(authMiddleware, adminMiddleware, deleteUser);

module.exports = router;
