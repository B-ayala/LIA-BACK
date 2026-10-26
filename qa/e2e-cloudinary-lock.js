/**
 * E2E por HTTP: TC-376 (503 ORDER_BUSY por bloqueo del producto) y TC-373/374 (borrado de la
 * imagen en Cloudinary solo si nada más la usa). Levanta el backend en el puerto 3998 con
 * RESERVE_LOCK_TIMEOUT_MS=300. Crea y borra productos `QA-E2E-*`, filas de prueba en
 * `carousel_images` (inactiva) y `site_content`, y assets en la carpeta `qa-e2e` de Cloudinary.
 * Pega contra la base y la cuenta de Cloudinary reales: exige confirmación.
 *
 * Uso: ALLOW_QA_AGAINST_THIS_DB=1 QA_ADMIN_EMAIL=... QA_ADMIN_PW=... QA_BUYER_EMAIL=... QA_BUYER_PW=... \
 *      node qa/e2e-cloudinary-lock.js
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const nodePath = require('path');
const path = `${nodePath.resolve(__dirname, '..')}/`;
const dotenv = require('dotenv');
dotenv.config({ path: path + '.env' });
if (process.env.ALLOW_QA_AGAINST_THIS_DB !== '1') {
  console.error(`Este test crea y borra datos reales en DB_HOST (${process.env.DB_HOST || 'no configurado'}) y Cloudinary. Confirmá con ALLOW_QA_AGAINST_THIS_DB=1.`);
  process.exit(1);
}
const dbPassword = process.env.DB_PASSWORD;
process.env.LOG_LEVEL = 'error';
process.chdir(path);
const { pool } = require(path + 'config/database');
const { cloudinaryRequest, getApiSecret } = require(path + 'utils/cloudinaryHttp');

const PORT = 3998;
const BASE = `http://localhost:${PORT}/api`;
const TAG = `QA-E2E-${Date.now()}`;
const CLOUD = process.env.CLOUDINARY_CLOUD_NAME;
const FOLDER = 'qa-e2e';
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const results = [];
const created = { products: [], publicIds: [], carousel: [], siteKeys: [] };

const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (method, url, { token, body } = {}) => {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const login = async (email, password) => {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status}`);
  return { token: r.json.data.accessToken };
};

const productRow = async (id) => (await pool.query('SELECT stock FROM public.productos WHERE id=$1', [id])).rows[0];
const productExists = async (id) => (await pool.query('SELECT 1 FROM public.productos WHERE id=$1', [id])).rowCount > 0;

const createProduct = async (admin, extra = {}) => {
  const r = await api('POST', '/products', { token: admin.token, body: { name: `${TAG}`, price: 1000, stock: 2, ...extra } });
  const id = String(r.json.data?.id);
  if (!r.json.data?.id) throw new Error(`crear producto -> ${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
  created.products.push(id);
  return id;
};

const uploadAsset = async (label) => {
  const publicId = `${TAG}-${label}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const toSign = `folder=${FOLDER}&public_id=${publicId}&timestamp=${timestamp}${getApiSecret()}`;
  const form = new URLSearchParams({
    file: PNG_1X1, api_key: process.env.CLOUDINARY_API_KEY, timestamp: String(timestamp), folder: FOLDER, public_id: publicId,
    signature: crypto.createHash('sha1').update(toSign).digest('hex'),
  });
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, { method: 'POST', body: form });
  const json = await res.json();
  if (!json.public_id) throw new Error(`subida a Cloudinary -> ${res.status} ${JSON.stringify(json).slice(0, 120)}`);
  created.publicIds.push(json.public_id);
  return { publicId: json.public_id, url: json.secure_url };
};

const assetExists = async (publicId) => {
  const r = await cloudinaryRequest('GET', `/v1_1/${CLOUD}/resources/image/upload/${encodeURIComponent(publicId)}`);
  return Boolean(r.public_id) && !r.error;
};
const assetGone = async (publicId) => {
  for (let i = 0; i < 6; i += 1) {
    if (!(await assetExists(publicId))) return true;
    await sleep(500);
  }
  return false;
};

const withAsset = async (admin, label, extra = {}) => {
  const asset = await uploadAsset(label);
  const id = await createProduct(admin, { status: 'inactive', imageUrl: asset.url, publicId: asset.publicId, images: [asset.url], ...extra });
  return { asset, id };
};

const scenarioLockTimeout = async (admin, buyer) => {
  const p = await createProduct(admin, { status: 'active', stock: 2 });
  const holder = await pool.connect();
  let busy;
  const started = Date.now();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM public.productos WHERE id=$1 FOR UPDATE', [p]);
    busy = await api('POST', '/orders/transfer', {
      token: buyer.token,
      body: { buyerName: 'QA Lock', shippingMethod: 'local', shippingCost: 0, totalPrice: 1000, items: [{ productId: p, productName: TAG, productImage: null, quantity: 1, unitPrice: 1000, totalPrice: 1000, unitsConfig: [] }] },
    });
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  const elapsed = Date.now() - started;
  check('TC-376: producto bloqueado -> 503 ORDER_BUSY', busy.status === 503 && busy.json.code === 'ORDER_BUSY', `status ${busy.status} code ${busy.json.code}`);
  check('TC-376: responde rápido (≈300 ms de lock_timeout, no 10 s)', elapsed < 3000, `${elapsed} ms`);
  const ventas = (await pool.query('SELECT 1 FROM public.ventas WHERE product_id=$1', [p])).rowCount;
  check('TC-376: sin orden creada y stock intacto', ventas === 0 && (await productRow(p)).stock === 2, `ventas=${ventas}`);
  const retry = await api('POST', '/orders/transfer', {
    token: buyer.token,
    body: { buyerName: 'QA Lock 2', shippingMethod: 'local', shippingCost: 0, totalPrice: 1000, items: [{ productId: p, productName: TAG, productImage: null, quantity: 1, unitPrice: 1000, totalPrice: 1000, unitsConfig: [] }] },
  });
  check('TC-376: liberado el bloqueo, la compra pasa (201) y descuenta', retry.status === 201 && (await productRow(p)).stock === 1, `status ${retry.status}`);
};

const scenarioImages = async (admin) => {
  const a = await withAsset(admin, 'a');
  check('TC-373: la imagen subida existe antes de borrar', await assetExists(a.asset.publicId));
  const del = await api('DELETE', `/products/${a.id}`, { token: admin.token });
  check('TC-373: borrar producto sin otros usos -> 200 y producto eliminado', del.status === 200 && !(await productExists(a.id)), `status ${del.status}`);
  check('TC-373: la imagen se borró de Cloudinary', await assetGone(a.asset.publicId));

  const b = await withAsset(admin, 'b');
  const carousel = await pool.query('INSERT INTO public.carousel_images (url, "order", is_active) VALUES ($1, 9999, false) RETURNING id', [b.asset.url]);
  created.carousel.push(carousel.rows[0].id);
  await api('DELETE', `/products/${b.id}`, { token: admin.token });
  check('TC-374: imagen usada por el carrusel -> el producto se borra pero la imagen queda', !(await productExists(b.id)) && (await assetExists(b.asset.publicId)));

  const c = await withAsset(admin, 'c');
  const c2 = await createProduct(admin, { status: 'inactive', imageUrl: c.asset.url, publicId: c.asset.publicId, images: [c.asset.url] });
  await api('DELETE', `/products/${c.id}`, { token: admin.token });
  check('TC-374: imagen usada por otro producto -> queda', await assetExists(c.asset.publicId));
  await api('DELETE', `/products/${c2}`, { token: admin.token });
  check('TC-374: al borrar el último producto que la usa -> se borra', await assetGone(c.asset.publicId));

  const d = await withAsset(admin, 'd');
  const key = `${TAG}-site`;
  await pool.query('INSERT INTO public.site_content (key, value) VALUES ($1, $2::jsonb)', [key, JSON.stringify({ image: d.asset.url })]);
  created.siteKeys.push(key);
  await api('DELETE', `/products/${d.id}`, { token: admin.token });
  check('TC-374: imagen usada por site_content -> queda', await assetExists(d.asset.publicId));
};

const cleanup = async (admin) => {
  const safe = async (label, fn) => { try { await fn(); } catch (e) { console.log(`cleanup ${label}: ${e.message}`); } };
  for (const id of created.carousel) await safe('carousel', () => pool.query('DELETE FROM public.carousel_images WHERE id=$1', [id]));
  for (const key of created.siteKeys) await safe('site_content', () => pool.query('DELETE FROM public.site_content WHERE key=$1', [key]));
  for (const p of created.products) {
    await safe('producto', async () => {
      await pool.query('DELETE FROM public.ventas WHERE product_id=$1', [p]);
      await pool.query('DELETE FROM public.productos WHERE id=$1', [p]);
    });
  }
  for (const pid of created.publicIds) {
    await safe('asset', () => cloudinaryRequest('DELETE', `/v1_1/${CLOUD}/resources/image/upload?public_ids%5B%5D=${encodeURIComponent(pid)}`));
  }
  const left = await Promise.all([
    pool.query("SELECT count(*)::int n FROM public.productos WHERE name LIKE 'QA-E2E-%'"),
    pool.query("SELECT count(*)::int n FROM public.carousel_images WHERE \"order\" = 9999"),
    pool.query("SELECT count(*)::int n FROM public.site_content WHERE key LIKE 'QA-E2E-%'"),
  ]);
  const stillThere = [];
  for (const pid of created.publicIds) if (await assetExists(pid)) stillThere.push(pid);
  console.log(`LIMPIEZA: productos=${left[0].rows[0].n}, carousel=${left[1].rows[0].n}, site_content=${left[2].rows[0].n}, assets restantes=${stillThere.length}`);
  void admin;
};

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: path,
    env: { ...process.env, PORT: String(PORT), DB_PASSWORD: dbPassword, LOG_LEVEL: 'error', NODE_ENV: 'development', RESERVE_LOCK_TIMEOUT_MS: '300' },
    stdio: 'ignore',
  });
  let admin = null;
  try {
    for (let i = 0; i < 40; i += 1) {
      try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.status < 500) break; } catch { /* aún no levantó */ }
      await sleep(500);
    }
    admin = await login(process.env.QA_ADMIN_EMAIL, process.env.QA_ADMIN_PW);
    const buyer = await login(process.env.QA_BUYER_EMAIL, process.env.QA_BUYER_PW);
    await scenarioLockTimeout(admin, buyer);
    await scenarioImages(admin);
  } catch (e) {
    check('EJECUCIÓN sin excepciones', false, e.message);
  } finally {
    await cleanup(admin);
    server.kill();
    await pool.end();
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\nRESUMEN: ${results.length - failed} ok, ${failed} fail`);
  }
})();
