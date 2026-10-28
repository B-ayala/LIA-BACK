const { z } = require('zod');
const { isValidEmail, MAX_EMAIL_LENGTH } = require('../utils/emailValidation');

/**
 * Validación de borde de /api/withdrawals (Botón de Arrepentimiento). Los topes
 * coinciden con los CHECK de `withdrawal_requests`: si se cambian, cambiar ambos.
 */

const MAX_NAME = 100;
const MAX_DESCRIPTION = 500;
const MAX_ADMIN_NOTE = 1000;
// `order_number` se lee como int4 (`::int`): un valor mayor no puede existir en la base.
const MAX_ORDER_NUMBER = 2147483647;
// `purchase_amount` es numeric(12,2): el tope evita un error de rango en la base.
const MAX_PURCHASE_AMOUNT = 9999999999;
const WITHDRAWAL_STATUSES = ['recibida', 'en_gestion', 'resuelta', 'rechazada'];

const emptyToUndefined = (value) => (value === '' || value === null ? undefined : value);

const nameSchema = z.string().trim().min(1, 'El nombre es requerido').max(MAX_NAME, `Máximo ${MAX_NAME} caracteres`);

const emailSchema = z.string().trim().toLowerCase()
  .max(MAX_EMAIL_LENGTH, 'El email es demasiado largo')
  .refine(isValidEmail, 'Ingresá un email válido');

const descriptionSchema = z.string().trim().min(1, 'Contanos qué compraste')
  .max(MAX_DESCRIPTION, `Máximo ${MAX_DESCRIPTION} caracteres`);

// Opcional: quien compró como invitado o perdió el mail igual puede arrepentirse. Con los datos
// opcionales (pedido, fecha, importe) el negocio encuentra la compra; sin ellos se revisa a mano.
const orderNumberSchema = z.preprocess(
  emptyToUndefined,
  z.coerce.number('El número de pedido debe ser un número').int('El número de pedido debe ser un entero')
    .positive('El número de pedido debe ser positivo').max(MAX_ORDER_NUMBER, 'El número de pedido no es válido')
    .optional()
);

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

const isRealPastDate = (value) => {
  const time = Date.parse(`${value}T00:00:00Z`);
  // `toISOString` descarta fechas como 2026-02-31 que Date.parse "corrige" en silencio.
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value)
    && time <= Date.now() + MS_PER_DAY;
};

const purchaseDateSchema = z.preprocess(
  emptyToUndefined,
  z.string().regex(ISO_DATE_PATTERN, 'Ingresá la fecha de compra').refine(isRealPastDate, 'La fecha de compra no es válida').optional()
);

const purchaseAmountSchema = z.preprocess(
  emptyToUndefined,
  z.coerce.number('El importe debe ser un número').positive('El importe debe ser positivo')
    .max(MAX_PURCHASE_AMOUNT, 'El importe no es válido').optional()
);

const createWithdrawalSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  description: descriptionSchema,
  orderNumber: orderNumberSchema,
  purchaseDate: purchaseDateSchema,
  purchaseAmount: purchaseAmountSchema,
});

const adminNoteSchema = z.string().trim().max(MAX_ADMIN_NOTE, `Máximo ${MAX_ADMIN_NOTE} caracteres`)
  .transform((note) => (note === '' ? null : note))
  .nullable();

const updateWithdrawalSchema = z.strictObject({
  status: z.enum(WITHDRAWAL_STATUSES).optional(),
  adminNote: adminNoteSchema.optional(),
}).refine((body) => body.status !== undefined || body.adminNote !== undefined, {
  message: 'Indicá el estado o la nota a actualizar.',
});

module.exports = { createWithdrawalSchema, updateWithdrawalSchema, WITHDRAWAL_STATUSES };
