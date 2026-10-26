/**
 * E2E por HTTP: levanta el backend en el puerto 3999 y prueba los endpoints reales de
 * transferencia, concurrencia del último ítem y contrato del PUT de productos.
 * Crea y borra sus propios productos `QA-E2E-*` (ACTIVOS unos minutos: son visibles en
 * el catálogo público mientras corre). Tarda ~3 min por el rate limit de checkout.
 * Pega contra la base de DB_HOST (la real si es la única): por eso exige confirmación.
 *
 * Uso: ALLOW_QA_AGAINST_THIS_DB=1 QA_ADMIN_EMAIL=... QA_ADMIN_PW=... QA_BUYER_EMAIL=... QA_BUYER_PW=...  *      node qa/e2e-endpoints.js
 * El comprador debe ser una cuenta habilitada para comprar (modo de compra restringida).
 */
const { spawn } = require('child_process');
const nodePath = require('path');
const path = `${nodePath.resolve(__dirname, '..')}/`;
const dotenv = require('dotenv');
dotenv.config({ path: path + '.env' });
if (process.env.ALLOW_QA_AGAINST_THIS_DB !== '1') {
  console.error(`Este test crea y borra datos reales en DB_HOST (${process.env.DB_HOST || 'no configurado'}). Confirmá con ALLOW_QA_AGAINST_THIS_DB=1.`);
  process.exit(1);
}
const dbPassword = process.env.DB_PASSWORD;
process.env.DB_PASSWORD = dbPassword;
process.env.LOG_LEVEL = 'error';
process.chdir(path);
const { pool } = require(path + 'config/database');

const PORT = 3999;
const BASE = `http://localhost:${PORT}/api`;
const TAG = `QA-E2E-${Date.now()}`;
const results = [];
const created = { products: [], orders: [] };

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
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

const login = async (email, password) => {
  const r = await api('POST', '/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} -> ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
  return { token: r.json.data.accessToken, email };
};

const dbRow = async (id) => (await pool.query('SELECT stock, status, updated_at::text AS u FROM public.productos WHERE id=$1', [id])).rows[0];
const ventas = async (productId) => (await pool.query('SELECT id, payment_status FROM public.ventas WHERE product_id=$1 ORDER BY created_at', [productId])).rows;

const createProduct = async (admin, stock) => {
  const r = await api('POST', '/products', { token: admin.token, body: { name: `${TAG}-${stock}`, price: 1000, stock, status: 'active' } });
  const id = String(r.json.data?.id ?? r.json.id);
  if (!id || id === 'undefined') throw new Error(`crear producto -> ${r.status} ${JSON.stringify(r.json).slice(0, 150)}`);
  created.products.push(id);
  return id;
};

const cart = (productId, qty, name = 'QA Buyer') => ({
  buyerName: name,
  shippingMethod: 'local',
  shippingCost: 0,
  totalPrice: 1000 * qty,
  items: [{ productId, productName: `${TAG}`, productImage: null, quantity: qty, unitPrice: 1000, totalPrice: 1000 * qty, unitsConfig: [] }],
});
const transfer = (buyer, productId, qty, name) => api('POST', '/orders/transfer', { token: buyer.token, body: cart(productId, qty, name) });

const pendingOf = async (pid) => (await ventas(pid)).filter((v) => v.payment_status === 'pendiente');
const cancelAll = async (admin, pid) => {
  for (const v of await pendingOf(pid)) await api('PATCH', `/orders/${v.id}/cancel-transfer`, { token: admin.token });
};

const waitForServer = async () => {
  for (let i = 0; i < 40; i += 1) {
    try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.status < 500) return; } catch { /* aún no levantó */ }
    await sleep(500);
  }
  throw new Error('el backend no levantó');
};

const scenarioTransferCycle = async (admin, buyer) => {
  const p = await createProduct(admin, 3);
  const r = await transfer(buyer, p, 1);
  check('TRF: compra por transferencia responde 2xx', r.status >= 200 && r.status < 300, `status ${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
  let row = await dbRow(p);
  check('TRF: stock 3 -> 2 (descuenta una vez, trigger sin GREATEST)', row.stock === 2, `stock=${row.stock}`);
  const pend = await pendingOf(p);
  check('TRF: queda 1 venta pendiente', pend.length === 1, `ventas=${pend.length}`);
  const c = await api('PATCH', `/orders/${pend[0]?.id}/cancel-transfer`, { token: admin.token });
  row = await dbRow(p);
  check('TRF: admin cancela -> stock vuelve a 3', c.status === 200 && row.stock === 3, `status ${c.status}, stock=${row.stock}`);
  const again = await api('PATCH', `/orders/${pend[0]?.id}/cancel-transfer`, { token: admin.token });
  check('TRF: cancelar de nuevo -> 409 y sin cambios', again.status === 409 && (await dbRow(p)).stock === 3, `status ${again.status}`);

  const t = await transfer(buyer, p, 1);
  const pend2 = await pendingOf(p);
  const conf = await api('PATCH', `/orders/${pend2[0]?.id}/confirm-transfer`, { token: admin.token });
  row = await dbRow(p);
  check('TRF: admin confirma -> pagado y stock NO se descuenta de nuevo', t.status < 300 && conf.status === 200 && row.stock === 2, `confirm ${conf.status}, stock=${row.stock}`);
  return p;
};

const scenarioDoubleSubmit = async (admin, buyer, p) => {
  await cancelAll(admin, p);
  const before = (await dbRow(p)).stock;
  const [a, b] = await Promise.all([transfer(buyer, p, 1, 'Doble Submit'), transfer(buyer, p, 1, 'Doble Submit')]);
  const after = (await dbRow(p)).stock;
  const pend = await pendingOf(p);
  check('CON: doble submit idéntico -> una sola orden y un solo descuento', pend.length === 1 && before - after === 1,
    `statuses ${a.status}/${b.status}, pendientes=${pend.length}, stock ${before}->${after}`);
  await cancelAll(admin, p);
};

const scenarioLastUnitRace = async (admin, buyer) => {
  const p = await createProduct(admin, 1);
  const results6 = await Promise.all(Array.from({ length: 6 }, (_, i) => transfer(buyer, p, 1, `Race ${i}`)));
  const ok = results6.filter((r) => r.status < 300).length;
  const conflicts = results6.filter((r) => r.status === 409).length;
  const row = await dbRow(p);
  const pend = await pendingOf(p);
  check('RACE: 6 compras simultáneas del último ítem -> 1 gana', ok === 1, `ok=${ok}, 409=${conflicts}, otros=${6 - ok - conflicts}`);
  check('RACE: stock final 0, nunca negativo, 1 venta', row.stock === 0 && pend.length === 1, `stock=${row.stock}, ventas=${pend.length}`);
  await cancelAll(admin, p);
  check('RACE: cancelar devuelve el ítem (stock 1)', (await dbRow(p)).stock === 1);
};

const scenarioEditContract = async (admin, p) => {
  const noDate = await api('PUT', `/products/${p}`, { token: admin.token, body: { stock: 9 } });
  check('PUT: stock sin expectedUpdatedAt -> 400 y sin cambios', noDate.status === 400 && (await dbRow(p)).stock !== 9, `status ${noDate.status}`);
  const nameOnly = await api('PUT', `/products/${p}`, { token: admin.token, body: { description: 'solo descripcion' } });
  check('PUT: editar solo descripción sin fecha -> 200', nameOnly.status === 200, `status ${nameOnly.status}`);
  const fresh = (await dbRow(p)).u;
  const stale = await api('PUT', `/products/${p}`, { token: admin.token, body: { stock: 7, expectedUpdatedAt: '2020-01-01 00:00:00+00' } });
  check('PUT: fecha vieja -> 409 PRODUCT_CHANGED y sin cambios', stale.status === 409 && (await dbRow(p)).stock !== 7, `status ${stale.status}`);
  const ok = await api('PUT', `/products/${p}`, { token: admin.token, body: { stock: 7, expectedUpdatedAt: fresh } });
  check('PUT: stock con fecha vigente -> 200 y stock 7', ok.status === 200 && (await dbRow(p)).stock === 7, `status ${ok.status}`);
};

const cleanup = async (admin) => {
  for (const p of created.products) {
    try {
      if (admin) await cancelAll(admin, p);
      await pool.query('DELETE FROM public.ventas WHERE product_id=$1', [p]);
      if (admin) await api('DELETE', `/products/${p}`, { token: admin.token });
      await pool.query('DELETE FROM public.productos WHERE id=$1', [p]);
    } catch (e) { console.log('cleanup error', p, e.message); }
  }
  const left = await pool.query("SELECT count(*)::int n FROM public.productos WHERE name LIKE 'QA-E2E-%'");
  console.log(`LIMPIEZA: productos QA-E2E restantes = ${left.rows[0].n}`);
};

(async () => {
  const server = spawn('node', ['server.js'], {
    cwd: path,
    env: { ...process.env, PORT: String(PORT), DB_PASSWORD: dbPassword, LOG_LEVEL: 'error', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  let admin = null;
  try {
    await waitForServer();
    admin = await login(process.env.QA_ADMIN_EMAIL, process.env.QA_ADMIN_PW);
    const buyer = await login(process.env.QA_BUYER_EMAIL, process.env.QA_BUYER_PW);
    const p1 = await scenarioTransferCycle(admin, buyer);
    await scenarioEditContract(admin, p1);
    console.log('... esperando 62 s por el rate limit de checkout (8/min por usuario)');
    await sleep(62000);
    await scenarioDoubleSubmit(admin, buyer, p1);
    await sleep(62000);
    await scenarioLastUnitRace(admin, buyer);
  } catch (e) {
    check('EJECUCIÓN sin excepciones', false, e.message);
    console.log(serverLog.split('\n').filter(Boolean).slice(-8).join('\n'));
  } finally {
    await cleanup(admin);
    server.kill();
    await pool.end();
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\nRESUMEN: ${results.length - failed} ok, ${failed} fail`);
  }
})();
