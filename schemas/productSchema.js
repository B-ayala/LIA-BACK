const { z } = require('zod');
const { variantSchema } = require('./variantSchema');

/**
 * Validación de borde para /api/products (solo admin, ver productRoutes.js).
 *
 * Los campos anidados complejos (specifications, features, faqs,
 * sizeGuide) se aceptan como arrays/objetos sueltos: su forma la valida el
 * front al construirlos y ya se persisten como JSON opaco en la base. Acá se
 * acota lo que sí importa para AppSec: tipos primitivos, longitudes y rangos
 * numéricos, para que un payload malformado nunca llegue a la query SQL.
 */

const MAX_TEXT = 500;
const MAX_LONG_TEXT = 5000;
const MAX_ARRAY_ITEMS = 50;
const MAX_CARD_OPTIONS = 10;
const MAX_CARD_OPTION_TEXT = 40;

// El precio con transferencia sale solo de `transfer_price`: un sello que lo mencione sería una
// segunda fuente que se desincroniza. Misma regla en el front (productCardOptions.ts) y en la base.
// "transferencia(s)", "transf." o "transf" suelto; deja pasar "transformá" o "transfiero".
const TRANSFER_LABEL_PATTERN = /\btransf(?:er[eé]ncia|\.|\b)/i;
const TRANSFER_LABEL_ERROR = 'El precio con transferencia se carga en Datos Básicos, campo "En transferencia ($)".';

const cardOptionSchema = z.object({
  label: z.string().trim().min(1).max(MAX_CARD_OPTION_TEXT)
    .refine((label) => !TRANSFER_LABEL_PATTERN.test(label), TRANSFER_LABEL_ERROR),
  icon: z.string().trim().min(1).max(MAX_CARD_OPTION_TEXT),
  isActive: z.boolean(),
});

const productBaseSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido').max(200),
  price: z.coerce.number().positive('El precio debe ser mayor a 0'),
  stock: z.coerce.number().int().min(0).optional(),
  category: z.string().trim().max(100).nullable().optional(),
  imageUrl: z.string().trim().max(2000).optional(),
  publicId: z.string().trim().max(300).optional(),
  images: z.array(z.string().trim().max(2000)).max(MAX_ARRAY_ITEMS).optional(),
  description: z.string().trim().max(MAX_LONG_TEXT).nullable().optional(),
  discount: z.coerce.number().min(0).max(100).nullable().optional(),
  // Precio de lista tachado; el controller lo descarta si no es mayor a `price`.
  originalPrice: z.coerce.number().positive().nullable().optional(),
  // Precio informativo "con transferencia" (solo se muestra; el checkout cobra `price`). null lo borra.
  transferPrice: z.coerce.number().positive().nullable().optional(),
  condition: z.enum(['new', 'used']).optional(),
  freeShipping: z.boolean().optional(),
  hoverImageEnabled: z.boolean().optional(),
  // null = usa las opciones globales; [] = sin sellos.
  cardOptions: z.array(cardOptionSchema).max(MAX_CARD_OPTIONS).nullable().optional(),
  variants: z.array(variantSchema).max(MAX_ARRAY_ITEMS).optional(),
  specifications: z.array(z.any()).max(MAX_ARRAY_ITEMS).optional(),
  features: z.array(z.any()).max(MAX_ARRAY_ITEMS).optional(),
  faqs: z.array(z.any()).max(MAX_ARRAY_ITEMS).optional(),
  warranty: z.string().trim().max(MAX_TEXT).nullable().optional(),
  returnPolicy: z.string().trim().max(MAX_LONG_TEXT).nullable().optional(),
  sizeGuide: z.any().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

// `updated_at` de Postgres serializado (PostgREST / pg): fecha, hora, hasta 6
// decimales y zona opcional. El valor exacto se compara en SQL (::timestamptz).
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

const createProductSchema = productBaseSchema;
// Escribir stock o variantes sin comparar `updated_at` pisaría el descuento de una compra concurrente.
const STOCK_FIELDS = ['stock', 'variants'];
const EXPECTED_UPDATED_AT_REQUIRED_MESSAGE =
  'Para modificar stock o talles hay que enviar la fecha de última modificación (expectedUpdatedAt).';

const updateProductSchema = productBaseSchema.partial().extend({
  expectedUpdatedAt: z.string().trim().regex(TIMESTAMP_PATTERN, 'Fecha de última modificación inválida').optional(),
}).superRefine((body, ctx) => {
  const touchesStock = STOCK_FIELDS.some((field) => body[field] !== undefined);
  if (touchesStock && body.expectedUpdatedAt === undefined) {
    ctx.addIssue({ code: 'custom', path: ['expectedUpdatedAt'], message: EXPECTED_UPDATED_AT_REQUIRED_MESSAGE });
  }
});

module.exports = { createProductSchema, updateProductSchema };
