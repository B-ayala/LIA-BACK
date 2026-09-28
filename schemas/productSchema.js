const { z } = require('zod');

/**
 * Validación de borde para /api/products (solo admin, ver productRoutes.js).
 *
 * Los campos anidados complejos (variants, specifications, features, faqs,
 * sizeGuide) se aceptan como arrays/objetos sueltos: su forma la valida el
 * front al construirlos y ya se persisten como JSON opaco en la base. Acá se
 * acota lo que sí importa para AppSec: tipos primitivos, longitudes y rangos
 * numéricos, para que un payload malformado nunca llegue a la query SQL.
 */

const MAX_TEXT = 500;
const MAX_LONG_TEXT = 5000;
const MAX_ARRAY_ITEMS = 50;

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
  condition: z.enum(['new', 'used']).optional(),
  freeShipping: z.boolean().optional(),
  hoverImageEnabled: z.boolean().optional(),
  variants: z.array(z.any()).max(MAX_ARRAY_ITEMS).optional(),
  specifications: z.array(z.any()).max(MAX_ARRAY_ITEMS).optional(),
  features: z.array(z.any()).max(MAX_ARRAY_ITEMS).optional(),
  faqs: z.array(z.any()).max(MAX_ARRAY_ITEMS).optional(),
  warranty: z.string().trim().max(MAX_TEXT).nullable().optional(),
  returnPolicy: z.string().trim().max(MAX_LONG_TEXT).nullable().optional(),
  sizeGuide: z.any().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

const createProductSchema = productBaseSchema;
const updateProductSchema = productBaseSchema.partial();

module.exports = { createProductSchema, updateProductSchema };
