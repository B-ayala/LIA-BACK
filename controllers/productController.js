const { pool } = require('../config/database');
const { caches, TTL, invalidateProducts } = require('../utils/cache');

const logger = require('../utils/logger');

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

/**
 * Responde un error de servidor sin exponer internals.
 *
 * Los errores de `pg` traen detalle de infraestructura (por ejemplo
 * `EMAXCONNSESSION ... pool_size: 15`, que revela el dimensionamiento de la
 * base). Eso va al log estructurado, no al cliente.
 */
const serverError = (res, action, error) => {
  logger.error(`products_${action}_failed`, { error: error.message, code: error.code });
  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'No se pudo completar la operación. Reintentá en unos segundos.',
  });
};

/** Entero saneado dentro de [min, max]; cae al default si no es válido. */
const boundedInt = (raw, fallback, min, max) => {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
};

// Create product
const createProduct = async (req, res) => {
  try {
    const {
      name, price, stock, category, imageUrl, publicId,
      description, discount, condition, freeShipping,
      variants, specifications, features, faqs, warranty, returnPolicy,
      sizeGuide, status, images,
    } = req.body;

    // name y price ya vienen validados por el schema Zod de la ruta (ver
    // schemas/productSchema.js).

    // Un producto "Activo" sin stock es un estado válido: se muestra en la
    // tienda marcado "Sin stock" y no se puede comprar (el front pide
    // confirmación explícita antes de llegar acá).

    // Derive imageUrl from images array if provided
    const resolvedImageUrl = (images && images.length > 0) ? images[0] : (imageUrl || '');
    const resolvedPublicId = publicId || '';

    const result = await pool.query(
      `INSERT INTO public.productos
       (name, price, stock, category, image_url, public_id, description,
        discount, condition, free_shipping, variants, specifications, features, faqs,
        warranty, return_policy, size_guide, status, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       RETURNING *`,
      [
        name,
        parseFloat(price),
        stock || 0,
        category || null,
        resolvedImageUrl,
        resolvedPublicId,
        description || null,
        discount ? parseFloat(discount) : null,
        condition || 'new',
        freeShipping || false,
        variants ? JSON.stringify(variants) : null,
        specifications ? JSON.stringify(specifications) : null,
        features ? JSON.stringify(features) : null,
        faqs ? JSON.stringify(faqs) : null,
        warranty || null,
        returnPolicy || null,
        sizeGuide ? JSON.stringify(sizeGuide) : null,
        status || 'active',
        images ? JSON.stringify(images) : null,
      ]
    );

    invalidateProducts();

    res.status(201).json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    return serverError(res, 'create', error);
  }
};

/**
 * Página del catálogo en UNA sola consulta: `COUNT(*) OVER()` devuelve el total
 * junto con las filas y evita el segundo round trip (dos queries por request se
 * notan cuando hay decenas de lectores simultáneos).
 */
const fetchProductPage = async (limit, offset) => {
  const result = await pool.query(
    `SELECT *, COUNT(*) OVER()::int AS total_count
       FROM public.productos
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const rows = result.rows.map(({ total_count, ...product }) => product);
  if (rows.length > 0) return { rows, total: result.rows[0].total_count };

  // Página vacía (offset fuera de rango): `COUNT(*) OVER()` no devuelve nada,
  // así que el total se resuelve aparte para no reportar 0 productos de más.
  const countResult = await pool.query('SELECT COUNT(*)::int AS total FROM public.productos');
  return { rows, total: countResult.rows[0].total };
};

// Get all products
const getProducts = async (req, res) => {
  try {
    const limit = boundedInt(req.query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = boundedInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    // Caché + single-flight: una ráfaga de lecturas de la misma página ejecuta
    // una sola query y comparte el resultado. Se invalida ante cualquier cambio
    // de producto o de stock (ver invalidateProducts).
    const { rows, total } = await caches.products.getOrSet(
      `list:${limit}:${offset}`,
      TTL.products,
      () => fetchProductPage(limit, offset)
    );

    res.json({
      success: true,
      data: rows,
      count: rows.length,
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    });
  } catch (error) {
    return serverError(res, 'list', error);
  }
};

// Get product by id
const getProductById = async (req, res) => {
  try {
    const { id } = req.params;

    // El detalle de un producto "popular" concentra muchas lecturas iguales:
    // es el caso donde más rinde el coalescing. `null` marca "no existe" y
    // también se cachea, para que un scraper de IDs inexistentes no golpee la BD.
    const product = await caches.products.getOrSet(`detail:${id}`, TTL.products, async () => {
      const result = await pool.query('SELECT * FROM public.productos WHERE id = $1', [id]);
      return result.rows[0] || null;
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Producto no encontrado',
      });
    }

    res.json({
      success: true,
      data: product,
    });
  } catch (error) {
    return serverError(res, 'detail', error);
  }
};

// Update product
const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, price, stock, category, imageUrl, publicId,
      description, discount, condition, freeShipping,
      variants, specifications, features, faqs, warranty, returnPolicy,
      sizeGuide, status, images,
    } = req.body;

    // Un producto "Activo" sin stock es un estado válido: se muestra en la
    // tienda marcado "Sin stock" y no se puede comprar (el front pide
    // confirmación explícita antes de llegar acá).

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      values.push(name);
    }
    if (price !== undefined) {
      updates.push(`price = $${paramCount++}`);
      values.push(parseFloat(price));
    }
    if (stock !== undefined) {
      updates.push(`stock = $${paramCount++}`);
      values.push(stock);
    }
    if (category !== undefined) {
      updates.push(`category = $${paramCount++}`);
      values.push(category);
    }
    if (images !== undefined) {
      updates.push(`images = $${paramCount++}`);
      values.push(JSON.stringify(images));
      // Keep image_url in sync with first image
      const firstImage = (images && images.length > 0) ? images[0] : (imageUrl || '');
      updates.push(`image_url = $${paramCount++}`);
      values.push(firstImage);
    } else if (imageUrl !== undefined) {
      updates.push(`image_url = $${paramCount++}`);
      values.push(imageUrl);
    }
    if (publicId !== undefined) {
      updates.push(`public_id = $${paramCount++}`);
      values.push(publicId);
    }
    if (description !== undefined) {
      updates.push(`description = $${paramCount++}`);
      values.push(description);
    }
    if (discount !== undefined) {
      updates.push(`discount = $${paramCount++}`);
      values.push(discount ? parseFloat(discount) : null);
    }
    if (condition !== undefined) {
      updates.push(`condition = $${paramCount++}`);
      values.push(condition);
    }
    if (freeShipping !== undefined) {
      updates.push(`free_shipping = $${paramCount++}`);
      values.push(freeShipping);
    }
    if (variants !== undefined) {
      updates.push(`variants = $${paramCount++}`);
      values.push(JSON.stringify(variants));
    }
    if (specifications !== undefined) {
      updates.push(`specifications = $${paramCount++}`);
      values.push(JSON.stringify(specifications));
    }
    if (features !== undefined) {
      updates.push(`features = $${paramCount++}`);
      values.push(JSON.stringify(features));
    }
    if (faqs !== undefined) {
      updates.push(`faqs = $${paramCount++}`);
      values.push(JSON.stringify(faqs));
    }
    if (warranty !== undefined) {
      updates.push(`warranty = $${paramCount++}`);
      values.push(warranty);
    }
    if (returnPolicy !== undefined) {
      updates.push(`return_policy = $${paramCount++}`);
      values.push(returnPolicy);
    }
    if (sizeGuide !== undefined) {
      updates.push(`size_guide = $${paramCount++}`);
      values.push(sizeGuide ? JSON.stringify(sizeGuide) : null);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramCount++}`);
      values.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No hay campos para actualizar',
      });
    }

    values.push(id);
    const query = `UPDATE public.productos SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramCount} RETURNING *`;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Producto no encontrado',
      });
    }

    invalidateProducts();

    res.json({
      success: true,
      data: result.rows[0],
    });
  } catch (error) {
    return serverError(res, 'update', error);
  }
};

// Delete product (and Cloudinary image)
const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    // Get product to find public_id
    const productResult = await pool.query(
      'SELECT public_id FROM public.productos WHERE id = $1',
      [id]
    );

    if (productResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Producto no encontrado',
      });
    }

    const productData = productResult.rows[0];

    // No borrar el asset de Cloudinary si otro producto usa el mismo `public_id`
    // (imagen compartida): Cloudinary borra por public_id, así que si otro producto
    // resuelve al mismo asset, borrarlo le rompería la imagen.
    let imageSharedWithOther = false;
    if (productData.public_id) {
      const shared = await pool.query(
        'SELECT 1 FROM public.productos WHERE id <> $1 AND public_id = $2 LIMIT 1',
        [id, productData.public_id]
      );
      imageSharedWithOther = shared.rows.length > 0;
      if (imageSharedWithOther) {
        logger.warn('cloudinary_asset_shared', { publicId: productData.public_id });
      }
    }

    // Delete from Cloudinary via our endpoint
    if (productData.public_id && !imageSharedWithOther) {
      try {
        const https = require('https');
        const auth = Buffer.from(
          `${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`
        ).toString('base64');

        const postData = `public_ids%5B%5D=${encodeURIComponent(productData.public_id)}`;

        await new Promise((resolve, reject) => {
          const options = {
            hostname: 'api.cloudinary.com',
            path: `/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/resources/image/destroy`,
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(postData),
            },
          };

          const request = https.request(options, (response) => {
            let data = '';
            response.on('data', (chunk) => {
              data += chunk;
            });
            response.on('end', () => {
              try {
                const result = JSON.parse(data);
                if (result.deleted && result.deleted[productData.public_id]) {
                  resolve(result);
                } else {
                  reject(new Error('Imagen no encontrada en Cloudinary'));
                }
              } catch (e) {
                reject(e);
              }
            });
          });

          request.on('error', reject);
          request.write(postData);
          request.end();
        });
      } catch (cloudinaryError) {
        logger.warn('cloudinary_delete_failed', { error: cloudinaryError.message });
        // Don't fail if Cloudinary deletion fails, just warn
      }
    }

    // Delete from PostgreSQL
    await pool.query('DELETE FROM public.productos WHERE id = $1', [id]);

    invalidateProducts();

    res.json({
      success: true,
      message: 'Producto eliminado exitosamente',
    });
  } catch (error) {
    return serverError(res, 'delete', error);
  }
};

module.exports = {
  createProduct,
  getProducts,
  getProductById,
  updateProduct,
  deleteProduct,
};
