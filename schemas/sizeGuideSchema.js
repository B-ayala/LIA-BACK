const { z } = require('zod');

/**
 * Validación de borde de `productos.size_guide`.
 *
 * Las columnas y filas (`type`, `columns`, `rows`, `columnSources`) se siguen
 * aceptando con la forma que ya tienen guardada los productos existentes
 * (passthrough): endurecerlas rechazaría guías viejas al editar cualquier otro
 * campo. Los bloques informativos (unidad, base de las medidas, aclaraciones y
 * referencia de calce) son nuevos y sí se validan estrictos: son texto que se
 * publica tal cual en la tienda.
 */

const MAX_NOTES = 8;
const MAX_NOTE_TEXT = 300;
const MAX_FIT_SIZE = 20;
const MAX_FIT_TEXT = 60;
const MAX_FIT_NOTES = 300;
const MAX_IMAGE_URL = 2000;
const MIN_MODEL_HEIGHT_CM = 100;
const MAX_MODEL_HEIGHT_CM = 230;

const optionalText = (max) => z.string().trim().max(max).optional();

const fitReferenceSchema = z.strictObject({
  modelHeightCm: z.number().int().min(MIN_MODEL_HEIGHT_CM).max(MAX_MODEL_HEIGHT_CM).optional(),
  topSize: optionalText(MAX_FIT_SIZE),
  bottomSize: optionalText(MAX_FIT_SIZE),
  fittedSize: optionalText(MAX_FIT_SIZE),
  fit: optionalText(MAX_FIT_TEXT),
  notes: optionalText(MAX_FIT_NOTES),
  // Foto de la biblioteca de imágenes o del producto. z.url() acepta `javascript:`; se exige https
  // para que nunca llegue a un `src` otro esquema.
  image: z.string().trim().max(MAX_IMAGE_URL).regex(/^https:\/\/[^\s]+$/, 'La imagen debe ser una URL https.').optional(),
});

const sizeGuideSchema = z.object({
  unit: z.enum(['cm', 'mm']).optional(),
  measurementBasis: z.enum(['body', 'garment']).optional(),
  // Ausente = usa las aclaraciones globales; presente = propias de este producto.
  notes: z.array(z.string().trim().min(1).max(MAX_NOTE_TEXT)).max(MAX_NOTES).optional(),
  // Ausente = modelo general (Admin > Talles > Guía de talles); custom = `fitReference`; hidden = no se muestra.
  fitReferenceMode: z.enum(['custom', 'hidden']).optional(),
  fitReference: fitReferenceSchema.optional(),
}).passthrough();

module.exports = { sizeGuideSchema };
