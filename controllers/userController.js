const User = require('../models/User');
const { getStatus, recordRateLimit } = require('../middleware/signupTracker');
const { checkLock, recordFailure, recordSuccess } = require('../middleware/loginBruteforce');
const logger = require('../utils/logger');

/**
 * Responde un error de servidor sin exponer internals (detalle de Postgres,
 * mensajes de Supabase, etc.). El detalle real va al log estructurado.
 */
const serverError = (res, action, error) => {
  logger.error(`users_${action}_failed`, { error: error.message });
  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'No se pudo completar la operación. Reintentá en unos segundos.',
  });
};

// Mensajes de validación de dominio que el modelo lanza intencionalmente
// (ver models/User.js): son los únicos seguros de reenviar al cliente tal cual.
const SAFE_USER_VALIDATION_ERROR =
  /^Error al (actualizar|eliminar) usuario: (El nombre no puede tener más de 100 caracteres|El rol debe ser "user" o "admin"|Debe proporcionar al menos un campo para actualizar \(name o role\)|Usuario no encontrado)$/;

/**
 * @desc    Login de usuario
 * @route   POST /api/users/login
 * @note    Valida las credenciales contra Supabase Auth (grant_type=password);
 *          nunca devuelve éxito sin verificar la contraseña.
 */
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email y contraseña son requeridos'
      });
    }

    const lock = checkLock(email);
    if (lock.locked) {
      res.setHeader('Retry-After', lock.retryAfterSeconds);
      logger.warn('login_locked', { retryAfterSeconds: lock.retryAfterSeconds });
      return res.status(429).json({
        success: false,
        code: 'ACCOUNT_LOCKED',
        message: 'Demasiados intentos fallidos. Esperá antes de volver a intentar.'
      });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
    const anonKey = process.env.SUPABASE_ANON_KEY || '';

    if (!supabaseUrl || !anonKey) {
      return res.status(503).json({
        success: false,
        message: 'Servicio de autenticación no disponible'
      });
    }

    const authResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ email, password })
    });

    if (!authResponse.ok) {
      recordFailure(email);
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    const user = await User.findByEmail(email);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Credenciales inválidas'
      });
    }

    recordSuccess(email);

    res.status(200).json({
      success: true,
      data: {
        id: user.id,
        user_id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    logger.error('users_login_failed', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'No se pudo validar las credenciales'
    });
  }
};

/**
 * @desc    Obtener todos los usuarios
 * @route   GET /api/users
 * @query   ?limit=50&offset=0
 */
exports.getUsers = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const result = await User.findAll(limit, offset);

    res.status(200).json({
      success: true,
      count: result.users.length,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      data: result.users
    });
  } catch (error) {
    return serverError(res, 'list', error);
  }
};

/**
 * @desc    Obtener un usuario por ID
 * @route   GET /api/users/:id
 */
exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'ID de usuario requerido'
      });
    }

    const user = await User.findById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error) {
    return serverError(res, 'get_by_id', error);
  }
};

/**
 * @desc    Crear un nuevo usuario
 * @route   POST /api/users
 * @note    Con Supabase Auth, el usuario se crea en el frontend y el trigger
 *          automáticamente crea el perfil en public.profiles
 *          Este endpoint es obsoleto pero se mantiene para compatibilidad
 */
exports.createUser = async (req, res) => {
  try {
    // Con Supabase Auth + trigger, el usuario y su perfil se crean automáticamente
    // Este endpoint no debería usarse normalmente
    
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        message: 'name y email son requeridos'
      });
    }

    // El usuario ya debería estar creado en Supabase Auth
    // y su perfil ya debería existir gracias al trigger
    // Este endpoint es solo una referencia legacy
    res.status(200).json({
      success: true,
      message: 'Usuario debe ser creado a través de Supabase Auth en el frontend',
      data: {
        name,
        email,
        role: 'user',
        note: 'Usar supabase.auth.signUp() en el frontend'
      }
    });
  } catch (error) {
    logger.error('users_create_failed', { error: error.message });
    res.status(400).json({
      success: false,
      message: 'No se pudo completar la operación.'
    });
  }
};

/**
 * @desc    Actualizar un usuario
 * @route   PUT /api/users/:id
 * @body    {name, email, role}
 */
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'ID de usuario requerido'
      });
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Debe proporcionar al menos un campo para actualizar'
      });
    }

    const user = await User.findByIdAndUpdate(id, updateData);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Usuario actualizado exitosamente',
      data: user
    });
  } catch (error) {
    logger.error('users_update_failed', { error: error.message });

    // El modelo lanza mensajes de validación de dominio conocidos (rol
    // inválido, nombre demasiado largo, no encontrado): son seguros de
    // mostrar. Cualquier otro error (fallo real de Postgres) no se reenvía
    // tal cual al cliente.
    if (SAFE_USER_VALIDATION_ERROR.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }

    res.status(400).json({
      success: false,
      message: 'No se pudo actualizar el usuario. Verificá los datos e intentá de nuevo.'
    });
  }
};

/**
 * @desc    Eliminar un usuario
 * @route   DELETE /api/users/:id
 */
exports.deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'ID de usuario requerido'
      });
    }

    const user = await User.findByIdAndDelete(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Usuario eliminado correctamente',
      data: user
    });
  } catch (error) {
    if (SAFE_USER_VALIDATION_ERROR.test(error.message)) {
      logger.warn('users_delete_rejected', { error: error.message });
      return res.status(400).json({ success: false, message: error.message });
    }
    return serverError(res, 'delete', error);
  }
};

/**
 * @desc    Leer estado de rate limit para un email (sin modificar nada)
 * @route   GET /api/users/signup-status/:email
 */
exports.signupStatus = (req, res) => {
  const { email } = req.params;
  if (!email) return res.status(400).json({ success: false, message: 'Email requerido' });
  return res.status(200).json({ success: true, ...getStatus(decodeURIComponent(email)) });
};

/**
 * @desc    Registrar que Supabase devolvió rate limit para un email
 * @route   POST /api/users/signup-ratelimit
 * @body    { email: string }
 */
exports.signupRateLimit = (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ success: false, message: 'Email requerido' });
  return res.status(200).json({ success: true, ...recordRateLimit(email) });
};

/**
 * @desc    Obtener usuario por user_id (Supabase Auth ID)
 * @route   GET /api/users/auth/:userId
 */
exports.getUserByAuthId = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'ID de usuario requerido'
      });
    }

    const user = await User.findByUserId(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Usuario no encontrado'
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error) {
    return serverError(res, 'get_by_auth_id', error);
  }
};
