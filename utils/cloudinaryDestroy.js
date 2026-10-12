/**
 * Borra un asset de imagen en Cloudinary por `public_id` (Admin API, Basic auth).
 * Rechaza si Cloudinary no confirma el borrado.
 */

const https = require('https');

const destroyCloudinaryImage = (publicId) => {
  const auth = Buffer.from(
    `${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`
  ).toString('base64');
  const postData = `public_ids%5B%5D=${encodeURIComponent(publicId)}`;

  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/image/destroy`,
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.deleted && result.deleted[publicId]) resolve(result);
          else reject(new Error('Imagen no encontrada en Cloudinary'));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.write(postData);
    request.end();
  });
};

module.exports = { destroyCloudinaryImage };
