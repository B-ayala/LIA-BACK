/**
 * Borra un asset de imagen en Cloudinary por `public_id` (Admin API, Basic auth).
 * Rechaza si Cloudinary no confirma el borrado.
 */

const { cloudinaryRequest } = require('./cloudinaryHttp');

const DELETED_STATUS = 'deleted';

const destroyCloudinaryImage = async (publicId) => {
  const result = await cloudinaryRequest(
    'DELETE',
    `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/image/upload?public_ids%5B%5D=${encodeURIComponent(publicId)}`
  );
  // `not_found` también es truthy: exigir el valor exacto para no dar por borrado un asset que no existe.
  if (result.deleted?.[publicId] !== DELETED_STATUS) throw new Error('Cloudinary no confirmó el borrado de la imagen');
  return result;
};

module.exports = { destroyCloudinaryImage };
