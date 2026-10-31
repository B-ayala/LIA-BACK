/**
 * Segunda pasada de auditoría (SEC-N01..N07): topes de acaparamiento, rate limit por
 * usuario, idempotencia entre usuarios, MFA opt-in, detalle de /health, PII en logs,
 * devoluciones parciales y atribución del actor en la auditoría.
 * Todo con base, Supabase Auth y Mercado Pago simulados.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, installFakeSupabaseAuth, createRes, startApp, abs } = require('./helpers/harness');

process.env.MP_ACCESS_TOKEN = 'APP_USR-test-token';
delete process.env.MP_WEBHOOK_SECRET;

const USER_A = { id: '22222222-2222-4222-8222-222222222222', email: 'a@example.test' };
const USER_B = { id: '33333333-3333-4333-8333-333333333333', email: 'b@example.test' };
const ADMIN = { id: '11111111-1111-4111-8111-111111111111', email: 'admin@example.test' };
const OTHERS_ORDER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ROLES = { [USER_A.id]: 'user', [USER_B.id]: 'user', [ADMIN.id]: 'admin' };

let product;
let pending;
const pool = installFakeDatabase((sql, params) => {
  if (sql.startsWith('SELECT id, role, name FROM public.profiles')) {
    return { rows: [{ id: params[0], role: ROLES[params[0]] || 'user', name: 'T' }] };
  }
  if (sql.includes('FROM public.productos') && sql.includes('FOR UPDATE') && sql.includes('WHERE id = $1')) {
    return { rows: product ? [product] : [] };
  }
  if (sql.includes("payment_status = 'pendiente'") && sql.includes('COUNT(*)')) return { rows: [pending] };
  if (sql.includes('ventas_order_number_seq')) return { rows: [{ order_number: 1001 }] };
  // Los compradores de estos tests ya aceptaron los términos vigentes.
  if (sql.includes('FROM public.terms_acceptances')) return { rows: [{ '?column?': 1 }] };
  if (sql.startsWith('INSERT INTO public.ventas')) return { rows: [{ id: `order-${pool.queries.length}` }] };
  if (sql.includes('FROM public.ventas WHERE id = ANY($1::uuid[])')) {
    return { rows: [{ id: OTHERS_ORDER, user_id: 'x', buyer_email: 'otro@example.test', payment_method: 'mp', payment_status: 'pendiente' }] };
  }
  return undefined;
});

installFakeSupabaseAuth({
  'a-token': USER_A,
  'b-token': USER_B,
  'admin-token': ADMIN,
});

const User = require(abs('models/User.js'));
User.getPurchasePermission = async () => ({ allowed: true });
const { createTransferOrder, mpWebhook } = require(abs('controllers/orderController.js'));
const OrderPayment = require(abs('models/OrderPayment.js'));
const mercadopago = require(abs('utils/mercadopago.js'));
const logger = require(abs('utils/logger.js'));

const validBody = (overrides = {}) => ({
  buyerName: 'Cliente Prueba',
  buyerEmail: USER_A.email,
  shippingMethod: 'local',
  shippingCost: 0,
  items: [{
    productId: 7, productName: 'Remera', productImage: 'x', quantity: 1, unitPrice: 1, totalPrice: 1, unitsConfig: [],
    ...(overrides.item || {}),
  }],
  ...overrides.body,
});

let cartCounter = 0;
// El total que mostraría el front: el servidor lo compara con el que cobra (precio 10000, retiro en local).
const withMatchingTotal = (body) => ({
  ...body,
  totalPrice: body.totalPrice ?? product.price * body.items.reduce((sum, item) => sum + item.quantity, 0),
});

const placeTransfer = async (user, rawBody, idempotencyKey) => {
  cartCounter += 1;
  const res = createRes();
  const body = withMatchingTotal(rawBody);
  const unique = { ...body, buyerName: `${body.buyerName} ${cartCounter}` };
  await createTransferOrder({
    body: idempotencyKey ? body : unique,
    user,
    get: (name) => (name.toLowerCase() === 'idempotency-key' ? idempotencyKey : undefined),
  }, res);
  return res;
};
const inserts = () => pool.queries.filter((q) => q.sql.startsWith('INSERT INTO public.ventas'));

beforeEach(() => {
  pool.queries.length = 0;
  pending = { pending: 0, units: 0 };
  product = {
    stock: 500, price: 10000, discount: null, original_price: null, name: 'Remera Lisa',
    image: 'db.jpg', variants: null, status: 'active',
  };
});

describe('SEC-N01: una sola línea o cuenta no acapara el stock', () => {
  test('NEGATIVO: una línea con más de 20 unidades se rechaza con 400 y no reserva nada', async () => {
    const res = await placeTransfer(USER_A, validBody({ item: { quantity: 21 } }));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'VALIDATION_ERROR');
    assert.equal(inserts().length, 0);
  });

  test('POSITIVO: exactamente 20 unidades se pueden comprar', async () => {
    const res = await placeTransfer(USER_A, validBody({ item: { quantity: 20 } }));
    assert.equal(res.statusCode, 201);
    assert.equal(inserts()[0].params[6], 20);
  });

  test('POSITIVO: el tope por línea se configura por entorno', async () => {
    process.env.MAX_QUANTITY_PER_LINE = '3';
    const blocked = await placeTransfer(USER_A, validBody({ item: { quantity: 4 } }));
    const allowed = await placeTransfer(USER_A, validBody({ item: { quantity: 3 } }));
    delete process.env.MAX_QUANTITY_PER_LINE;
    assert.equal(blocked.statusCode, 400);
    assert.equal(allowed.statusCode, 201);
  });

  test('NEGATIVO: con 55 unidades ya pendientes, pedir 10 más supera el tope de 60 y da 429', async () => {
    pending = { pending: 3, units: 55 };
    const res = await placeTransfer(USER_A, validBody({ item: { quantity: 10 } }));
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'TOO_MANY_PENDING_ORDERS');
    assert.equal(inserts().length, 0);
  });

  test('POSITIVO: con 50 unidades pendientes, pedir 10 llega justo al tope y se reserva', async () => {
    pending = { pending: 3, units: 50 };
    const res = await placeTransfer(USER_A, validBody({ item: { quantity: 10 } }));
    assert.equal(res.statusCode, 201);
  });
});

describe('Idempotency-Key: no se cruza entre usuarios', () => {
  const KEY = 'clave-de-idempotencia-12345';

  test('NEGATIVO: el usuario B con la misma key que A recibe SU propia compra, no la respuesta guardada de A', async () => {
    const first = await placeTransfer(USER_A, validBody(), KEY);
    assert.equal(first.statusCode, 201);
    const insertsAfterA = inserts().length;
    const other = await placeTransfer(USER_B, validBody({ body: { buyerEmail: USER_B.email } }), KEY);
    assert.equal(other.statusCode, 201);
    assert.equal(inserts().length, insertsAfterA + 1, 'B ejecutó su propia reserva');
    assert.notDeepEqual(other.body.order_ids, first.body.order_ids);
  });

  test('POSITIVO: el reintento de A con la misma key y el mismo carrito devuelve lo mismo sin reservar otra vez', async () => {
    const first = await placeTransfer(USER_A, validBody({ body: { buyerName: 'Reintento' } }), 'otra-clave-de-prueba-99');
    const count = inserts().length;
    const retry = await placeTransfer(USER_A, validBody({ body: { buyerName: 'Reintento' } }), 'otra-clave-de-prueba-99');
    assert.equal(retry.statusCode, 201);
    assert.deepEqual(retry.body.order_ids, first.body.order_ids);
    assert.equal(inserts().length, count);
  });

  test('NEGATIVO: la misma key con un carrito distinto es un error 422, no una orden nueva', async () => {
    await placeTransfer(USER_A, validBody({ body: { buyerName: 'Carrito uno' } }), 'clave-reusada-abcdefgh');
    const count = inserts().length;
    const reused = await placeTransfer(USER_A, validBody({ body: { buyerName: 'Carrito dos' } }), 'clave-reusada-abcdefgh');
    assert.equal(reused.statusCode, 422);
    assert.equal(reused.body.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(inserts().length, count);
  });
});

describe('SEC-N02: rate limit por usuario en checkout y autorización de las rutas nuevas', () => {
  let app;
  before(async () => { app = await startApp([['/api/orders', 'routes/orderRoutes.js']]); });
  after(() => app.close());

  const call = async (method, path, { token, body } = {}) => {
    const response = await fetch(`${app.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  test('NEGATIVO: confirm-late-transfer sin token da 401 y con usuario común 403', async () => {
    const path = `/api/orders/${OTHERS_ORDER}/confirm-late-transfer`;
    assert.equal((await call('PATCH', path)).status, 401);
    assert.equal((await call('PATCH', path, { token: 'a-token' })).status, 403);
  });

  test('NEGATIVO: mp-cancel con la orden de otro usuario da 403 y no modifica nada', async () => {
    pool.queries.length = 0;
    const res = await call('POST', '/api/orders/mp-cancel', { token: 'a-token', body: { orderIds: [OTHERS_ORDER] } });
    assert.equal(res.status, 403);
    assert.equal(pool.queries.some((q) => q.sql.startsWith('UPDATE')), false);
  });

  test('NEGATIVO: la cuenta que supera 8 compras por minuto recibe 429; otra cuenta desde la misma IP no', async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 9; attempt += 1) {
      statuses.push((await call('POST', '/api/orders/transfer', { token: 'a-token', body: {} })).status);
    }
    assert.deepEqual(statuses.slice(0, 8), Array(8).fill(400), 'las primeras 8 llegan a la validación');
    assert.equal(statuses[8], 429);
    const other = await call('POST', '/api/orders/transfer', { token: 'b-token', body: {} });
    assert.equal(other.status, 400, 'B no hereda el bloqueo de A');
  });
});

describe('SEC-N03: devoluciones parciales de un pago aprobado quedan marcadas', () => {
  let reviewCalls;
  beforeEach(() => {
    reviewCalls = [];
    OrderPayment.findIdsByReference = async () => ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
    OrderPayment.markPaidByIds = async (ids) => ids.length;
    OrderPayment.setReviewReason = async (ids, reason, options) => { reviewCalls.push({ ids, reason, options }); return ids.length; };
  });

  const notify = async (payment) => {
    mercadopago.getPayment = async () => payment;
    const res = createRes();
    await mpWebhook({ query: { type: 'payment', 'data.id': '4242' }, headers: {}, body: {} }, res);
    return res;
  };
  const approved = (extra = {}) => ({
    id: 4242, status: 'approved', external_reference: 'ref-1', transaction_amount: 5000, currency_id: 'ARS', ...extra,
  });

  test('NEGATIVO: aprobado con devolución parcial se salda y además se marca "refunded" para el admin', async () => {
    const res = await notify(approved({ transaction_amount_refunded: 1500 }));
    assert.equal(res.statusCode, 200);
    assert.equal(reviewCalls.length, 1);
    assert.equal(reviewCalls[0].reason, 'refunded');
    assert.equal(reviewCalls[0].options.status, 'paid');
    assert.equal(reviewCalls[0].options.paymentId, 4242);
  });

  test('POSITIVO: aprobado sin devolución no se marca', async () => {
    await notify(approved({ transaction_amount_refunded: 0 }));
    assert.equal(reviewCalls.length, 0);
  });

  test('NEGATIVO: contracargo se sigue marcando "charged_back"', async () => {
    await notify(approved({ status: 'charged_back' }));
    assert.equal(reviewCalls[0].reason, 'charged_back');
  });
});

describe('SEC-N04: PII fuera de los logs', () => {
  test('NEGATIVO: el log de rate limit no guarda la query string (email del comprador)', () => {
    const { createRateLimit } = require(abs('middleware/rateLimit.js'));
    const warnings = [];
    const original = logger.warn;
    logger.warn = (message, context) => warnings.push({ message, context });
    try {
      const limit = createRateLimit({ name: 'pii-test', windowMs: 60000, max: 1 });
      const request = { method: 'GET', originalUrl: '/api/orders/user?email=victima@example.test', ip: '9.9.9.9' };
      const response = { setHeader() {}, status() { return this; }, json() { return this; } };
      limit(request, response, () => undefined);
      limit(request, response, () => undefined);
    } finally {
      logger.warn = original;
    }
    const blocked = warnings.find((entry) => entry.message === 'rate_limit_blocked');
    assert.ok(blocked, 'debe loguear el bloqueo');
    assert.equal(blocked.context.path, '/api/orders/user');
    assert.doesNotMatch(JSON.stringify(blocked), /victima@example\.test/);
  });
});

describe('SEC-N05: detalle de /health', () => {
  const { canSeeHealthDetail } = require(abs('middleware/healthAccess.js'));
  const withEnv = (env, run) => {
    const saved = { NODE_ENV: process.env.NODE_ENV, HEALTH_DETAIL_TOKEN: process.env.HEALTH_DETAIL_TOKEN };
    Object.entries(env).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    });
    try { return run(); } finally {
      Object.entries(saved).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      });
    }
  };

  test('NEGATIVO: en producción sin token el público no ve el detalle', () => {
    assert.equal(withEnv({ NODE_ENV: 'production', HEALTH_DETAIL_TOKEN: undefined }, () => canSeeHealthDetail({ headers: {} })), false);
  });

  test('NEGATIVO: con token configurado, uno ausente o incorrecto no alcanza', () => {
    const env = { NODE_ENV: 'production', HEALTH_DETAIL_TOKEN: 'secreto-largo' };
    assert.equal(withEnv(env, () => canSeeHealthDetail({ headers: {} })), false);
    assert.equal(withEnv(env, () => canSeeHealthDetail({ headers: { 'x-health-token': 'otro' } })), false);
  });

  test('POSITIVO: con el token correcto, o en desarrollo, se ve el detalle', () => {
    const env = { NODE_ENV: 'production', HEALTH_DETAIL_TOKEN: 'secreto-largo' };
    assert.equal(withEnv(env, () => canSeeHealthDetail({ headers: { 'x-health-token': 'secreto-largo' } })), true);
    assert.equal(withEnv({ NODE_ENV: 'development', HEALTH_DETAIL_TOKEN: undefined }, () => canSeeHealthDetail({ headers: {} })), true);
  });
});

describe('SEC-N06: MFA para admin (opt-in) y errores sin detalle interno', () => {
  const { adminMiddleware, tokenAssuranceLevel } = require(abs('middleware/authMiddleware.js'));
  const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const run = (token) => {
    const res = createRes();
    let passed = false;
    adminMiddleware({ user: { id: ADMIN.id, role: 'admin' }, token }, res, () => { passed = true; });
    return { res, passed };
  };

  test('POSITIVO: sin ADMIN_REQUIRE_MFA el admin pasa con sesión aal1 (comportamiento actual)', () => {
    delete process.env.ADMIN_REQUIRE_MFA;
    assert.equal(run(jwt({ aal: 'aal1' })).passed, true);
  });

  test('NEGATIVO: con ADMIN_REQUIRE_MFA=true una sesión aal1, sin claim o ilegible da 403 MFA_REQUIRED', () => {
    process.env.ADMIN_REQUIRE_MFA = 'true';
    try {
      for (const token of [jwt({ aal: 'aal1' }), jwt({}), 'no-es-un-jwt']) {
        const { res, passed } = run(token);
        assert.equal(passed, false);
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, 'MFA_REQUIRED');
      }
    } finally {
      delete process.env.ADMIN_REQUIRE_MFA;
    }
  });

  test('POSITIVO: con ADMIN_REQUIRE_MFA=true una sesión aal2 pasa', () => {
    process.env.ADMIN_REQUIRE_MFA = 'true';
    try {
      assert.equal(run(jwt({ aal: 'aal2' })).passed, true);
      assert.equal(tokenAssuranceLevel(jwt({ aal: 'aal2' })), 'aal2');
    } finally {
      delete process.env.ADMIN_REQUIRE_MFA;
    }
  });

  test('NEGATIVO: un usuario común sigue recibiendo 403 aunque tenga aal2', () => {
    const res = createRes();
    let passed = false;
    adminMiddleware({ user: { id: USER_A.id, role: 'user' }, token: jwt({ aal: 'aal2' }) }, res, () => { passed = true; });
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
  });
});

describe('SEC-N07: atribución del actor en la transacción', () => {
  const { createTransactionRunner } = require(abs('utils/transaction.js'));
  const runner = () => {
    const queries = [];
    const client = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; }, release: () => undefined };
    return { queries, run: createTransactionRunner({ connect: async () => client }) };
  };

  test('POSITIVO: con un uuid de actor, la transacción lo fija localmente (set_config con is_local = true)', async () => {
    const { queries, run } = runner();
    await run('t', async () => 1, { actor: USER_A.id.toUpperCase() });
    const setting = queries.find((q) => q.sql.includes('set_config'));
    assert.ok(setting);
    assert.match(setting.sql, /set_config\('app\.actor', \$1, true\)/);
    assert.deepEqual(setting.params, [USER_A.id]);
    assert.equal(queries[0].sql, 'BEGIN');
  });

  test('NEGATIVO: un actor que no es uuid (o ausente) no se interpola ni se envía a la base', async () => {
    const { queries, run } = runner();
    await run('t', async () => 1, { actor: "x'); DROP TABLE ventas;--" });
    await run('t', async () => 1);
    assert.equal(queries.some((q) => q.sql.includes('set_config')), false);
    assert.equal(queries.some((q) => q.sql.includes('DROP')), false);
  });
});
