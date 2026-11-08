/**
 * Tanda 3 (S-12/H-08, H-05, S-06, S-07, S-08): webhook fail-closed y firma con antigüedad, circuito por latencia,
 * IDOR en mp-confirm, expiración de preferencias al cancelar y logs sin console.
 * Todo con base y Mercado Pago simulados: ninguna llamada real.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { installFakeDatabase, createRes, abs } = require('../../test/helpers/harness');

const SECRET = 'whsec-hardening';
const OWNER_EMAIL = 'duena@example.test';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const PREFERENCE_ID = 'pref-123';
const FIVE_MINUTES_MS = 5 * 60 * 1000;

process.env.MP_ACCESS_TOKEN = 'APP_USR-test-token';
process.env.MP_WEBHOOK_SECRET = SECRET;
process.env.LOG_LEVEL = 'error';

const state = { orders: [], lockedOrder: null };
const pool = installFakeDatabase((sql) => {
  if (sql.includes('WHERE mp_external_reference = $1')) return { rows: state.orders.map((order) => ({ id: order.id })) };
  if (sql.includes('SELECT * FROM public.ventas WHERE id = ANY')) return { rows: state.orders };
  if (sql.includes('SELECT * FROM public.ventas WHERE id = $1::uuid FOR UPDATE')) return { rows: state.lockedOrder ? [state.lockedOrder] : [] };
  return undefined;
});

const mercadopago = require(abs('utils/mercadopago.js'));
const OrderPayment = require(abs('models/OrderPayment.js'));
const logger = require(abs('utils/logger.js'));
const { createCircuitBreaker } = require(abs('utils/circuitBreaker.js'));
const { mpWebhook, confirmMpPayment } = require(abs('controllers/orderController.js'));
const { cancelMpOrder, cancelMpPurchases } = require(abs('services/mpCancellation.js'));
const { expireReleasedPreferences } = require(abs('services/mpPreferenceExpiry.js'));

const sign = (dataId, { ts, secret = SECRET, requestId = 'req-1' }) => {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  return `ts=${ts},v1=${crypto.createHmac('sha256', secret).update(manifest).digest('hex')}`;
};

const captureLogs = (level, run) => {
  const entries = [];
  const original = logger[level];
  logger[level] = (message, context) => entries.push({ message, context });
  return Promise.resolve(run()).finally(() => { logger[level] = original; }).then(() => entries);
};

describe('S-12: firma del webhook con antigüedad máxima', () => {
  const NOW = 1_800_000_000_000;
  const verify = (ts, extra = {}) => mercadopago.verifyWebhookSignature({
    signatureHeader: sign(123, { ts }), requestId: 'req-1', dataId: 123, now: NOW, ...extra,
  });

  test('ts reciente (segundos o milisegundos) es válido', () => {
    assert.equal(verify(String(NOW / 1000 - 30)), true);
    assert.equal(verify(String(NOW - 30_000)), true);
  });

  test('ts más viejo que 5 minutos se rechaza aunque el HMAC sea correcto', () => {
    assert.equal(mercadopago.WEBHOOK_SIGNATURE_MAX_AGE_MS, FIVE_MINUTES_MS);
    assert.equal(verify(String(NOW / 1000 - 301)), false);
    assert.equal(verify(String(NOW - FIVE_MINUTES_MS - 1000)), false);
  });

  test('ts del futuro más allá de la tolerancia también se rechaza', () => {
    assert.equal(verify(String(NOW / 1000 + 600)), false);
  });

  test('firma de otra clave sigue siendo inválida (no se evalúa la fecha antes)', () => {
    assert.equal(mercadopago.verifyWebhookSignature({
      signatureHeader: sign(123, { ts: String(NOW / 1000), secret: 'otra' }), requestId: 'req-1', dataId: 123, now: NOW,
    }), false);
  });
});

describe('S-12: webhook sin MP_WEBHOOK_SECRET', () => {
  const webhookReq = () => ({ query: { type: 'payment', 'data.id': '123456' }, headers: {}, body: {} });
  let getPaymentCalls;

  beforeEach(() => {
    getPaymentCalls = 0;
    mercadopago.getPayment = async () => { getPaymentCalls += 1; return { status: 'pending', external_reference: ORDER_ID }; };
  });

  const withoutSecret = async (nodeEnv, run) => {
    const saved = { secret: process.env.MP_WEBHOOK_SECRET, env: process.env.NODE_ENV };
    delete process.env.MP_WEBHOOK_SECRET;
    process.env.NODE_ENV = nodeEnv;
    try { return await run(); } finally {
      process.env.MP_WEBHOOK_SECRET = saved.secret;
      if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
    }
  };

  test('producción: falla cerrado con 401, no consulta a MP y alerta UNA sola vez', async () => {
    const errors = await captureLogs('error', async () => withoutSecret('production', async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = createRes();
        await mpWebhook(webhookReq(), res);
        assert.equal(res.statusCode, 401);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, 'WEBHOOK_NOT_CONFIGURED');
      }
    }));
    assert.equal(getPaymentCalls, 0);
    assert.equal(errors.filter((entry) => entry.message === 'mp_webhook_secret_missing').length, 1);
  });

  test('producción con MP_WEBHOOK_ALLOW_UNSIGNED=true: acepta sin firma y revalida contra MP', async () => {
    process.env.MP_WEBHOOK_ALLOW_UNSIGNED = 'true';
    try {
      await captureLogs('warn', async () => withoutSecret('production', async () => {
        const res = createRes();
        await mpWebhook(webhookReq(), res);
        assert.equal(res.statusCode, 200);
      }));
    } finally {
      delete process.env.MP_WEBHOOK_ALLOW_UNSIGNED;
    }
    assert.equal(getPaymentCalls, 1);
  });

  test('desarrollo/test: sigue permisivo (revalida contra MP) con warning', async () => {
    const warnings = await captureLogs('warn', async () => withoutSecret('test', async () => {
      const res = createRes();
      await mpWebhook(webhookReq(), res);
      assert.equal(res.statusCode, 200);
    }));
    assert.equal(getPaymentCalls, 1);
    assert.ok(warnings.some((entry) => entry.message === 'mp_webhook_unsigned_allowed'));
  });

  test('producción con secreto configurado: una firma válida y fresca pasa', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const ts = String(Math.floor(Date.now() / 1000));
      const res = createRes();
      await mpWebhook({
        query: { type: 'payment', 'data.id': '123456' },
        headers: { 'x-signature': sign(123456, { ts }), 'x-request-id': 'req-1' },
        body: {},
      }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(getPaymentCalls, 1);
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved;
    }
  });
});

describe('H-05: circuito de MP por latencia sostenida', () => {
  const createClock = () => { const clock = { time: 0, now: () => clock.time }; return clock; };
  const slowCall = (clock, ms) => async () => { clock.time += ms; return 'ok'; };

  test('cinco respuestas EXITOSAS pero lentas seguidas abren el circuito', async () => {
    const clock = createClock();
    const breaker = createCircuitBreaker({
      name: 't', failureThreshold: 5, openMs: 30000, isFailure: () => true, slowCallMs: 3000, now: clock.now,
    });
    for (let index = 0; index < 4; index += 1) await breaker.execute(slowCall(clock, 3500));
    assert.equal(breaker.state(), 'closed');
    await breaker.execute(slowCall(clock, 3500));
    assert.equal(breaker.state(), 'open');
    await assert.rejects(() => breaker.execute(slowCall(clock, 1)), { code: 'CIRCUIT_OPEN' });
  });

  test('una respuesta rápida en el medio reinicia la cuenta (no es "sostenida")', async () => {
    const clock = createClock();
    const breaker = createCircuitBreaker({
      name: 't', failureThreshold: 3, openMs: 30000, isFailure: () => true, slowCallMs: 3000, now: clock.now,
    });
    await breaker.execute(slowCall(clock, 4000));
    await breaker.execute(slowCall(clock, 4000));
    await breaker.execute(slowCall(clock, 100));
    await breaker.execute(slowCall(clock, 4000));
    await breaker.execute(slowCall(clock, 4000));
    assert.equal(breaker.state(), 'closed');
  });

  test('sin slowCallMs el comportamiento anterior no cambia', async () => {
    const clock = createClock();
    const breaker = createCircuitBreaker({ name: 't', failureThreshold: 1, openMs: 1000, isFailure: () => true, now: clock.now });
    await breaker.execute(slowCall(clock, 60000));
    assert.equal(breaker.state(), 'closed');
  });

  test('crear la preferencia espera como máximo 5 s y el umbral lento es menor al timeout', () => {
    assert.ok(mercadopago.MP_PREFERENCE_TIMEOUT_MS >= 4000 && mercadopago.MP_PREFERENCE_TIMEOUT_MS <= 5000);
    assert.ok(mercadopago.MP_SLOW_CALL_MS < mercadopago.MP_PREFERENCE_TIMEOUT_MS);
  });
});

describe('S-07: mp-confirm exige que el pago sea del usuario (o admin)', () => {
  let settled;

  beforeEach(() => {
    settled = [];
    state.orders = [{ id: ORDER_ID, buyer_email: OWNER_EMAIL }];
    mercadopago.getPayment = async () => ({
      id: 555, status: 'approved', external_reference: 'purchase-1', transaction_amount: 5000, currency_id: 'ARS',
    });
    OrderPayment.markPaidByIds = async (ids) => { settled.push(ids); return ids.length; };
  });

  const confirm = async (user) => {
    const res = createRes();
    await confirmMpPayment({ body: { paymentId: '555' }, user }, res);
    return res;
  };

  test('IDOR: otro usuario autenticado recibe 403 y NO se salda nada', async () => {
    const res = await confirm({ id: 'u-2', email: 'intruso@example.test', role: 'user' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'FORBIDDEN');
    assert.equal(settled.length, 0);
  });

  test('el dueño (email sin distinguir mayúsculas) confirma su pago', async () => {
    const res = await confirm({ id: 'u-1', email: OWNER_EMAIL.toUpperCase(), role: 'user' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(settled, [[ORDER_ID]]);
  });

  test('un admin puede confirmar el pago de cualquiera', async () => {
    const res = await confirm({ id: 'a-1', email: 'admin@example.test', role: 'admin' });
    assert.equal(res.statusCode, 200);
    assert.equal(settled.length, 1);
  });

  test('si UNA sola de las ventas del pago es ajena, se rechaza todo', async () => {
    state.orders = [{ id: ORDER_ID, buyer_email: OWNER_EMAIL }, { id: '22222222-2222-4222-8222-222222222222', buyer_email: 'otra@example.test' }];
    const res = await confirm({ id: 'u-1', email: OWNER_EMAIL, role: 'user' });
    assert.equal(res.statusCode, 403);
    assert.equal(settled.length, 0);
  });

  test('un usuario sin email en la sesión no es dueño de nada', async () => {
    const res = await confirm({ id: 'u-3', email: null, role: 'user' });
    assert.equal(res.statusCode, 403);
  });
});

describe('S-06: expirar la preferencia de MP al cancelar', () => {
  let expireCalls;
  let expirable;

  beforeEach(() => {
    expireCalls = [];
    expirable = [PREFERENCE_ID];
    mercadopago.expirePreference = async (id, payload) => { expireCalls.push({ id, payload }); return {}; };
    OrderPayment.findPreferencesWithoutPendingOrders = async (ids) => ids.filter((id) => expirable.includes(id));
  });

  test('expira con expires=true y fecha = ahora; ignora vacíos y repetidos', async () => {
    const before = Date.now();
    await expireReleasedPreferences([PREFERENCE_ID, PREFERENCE_ID, null, undefined, '']);
    assert.equal(expireCalls.length, 1);
    assert.equal(expireCalls[0].id, PREFERENCE_ID);
    assert.equal(expireCalls[0].payload.expires, true);
    const stamp = Date.parse(expireCalls[0].payload.expiration_date_to);
    assert.ok(stamp >= before - 1000 && stamp <= Date.now() + 1000);
  });

  test('no expira una preferencia que todavía tiene ventas pendientes (línea hermana del carrito)', async () => {
    expirable = [];
    await expireReleasedPreferences([PREFERENCE_ID]);
    assert.equal(expireCalls.length, 0);
  });

  test('si MP falla, no lanza: se loguea y listo', async () => {
    mercadopago.expirePreference = async () => { throw Object.assign(new Error('MP caído'), { status: 503 }); };
    const warnings = await captureLogs('warn', async () => {
      await assert.doesNotReject(() => expireReleasedPreferences([PREFERENCE_ID]));
    });
    assert.ok(warnings.some((entry) => entry.message === 'mp_preference_expire_failed'));
  });

  test('si falla la consulta a la base, tampoco lanza', async () => {
    OrderPayment.findPreferencesWithoutPendingOrders = async () => { throw new Error('db'); };
    await assert.doesNotReject(() => expireReleasedPreferences([PREFERENCE_ID]));
  });

  test('cancelMpOrder: la orden se cancela en base y la preferencia se expira sin esperarla', async () => {
    state.lockedOrder = { id: ORDER_ID, payment_method: 'mp', payment_status: 'pendiente', product_id: null, quantity: 1 };
    let releaseMp;
    mercadopago.expirePreference = (id, payload) => {
      expireCalls.push({ id, payload });
      return new Promise((resolve) => { releaseMp = resolve; });
    };
    const order = { id: ORDER_ID, payment_method: 'mp', payment_status: 'pendiente', mp_preference_id: PREFERENCE_ID };
    const outcome = await cancelMpOrder(order);
    assert.equal(outcome, 'cancelled', 'no quedó esperando a MP');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(expireCalls.length, 1);
    assert.ok(pool.queries.some((query) => query.sql.includes('UPDATE public.ventas SET payment_status')), 'canceló en base');
    if (releaseMp) releaseMp({});
  });

  test('cancelMpOrder: si MP rechaza expirar, igual se cancela', async () => {
    state.lockedOrder = { id: ORDER_ID, payment_method: 'mp', payment_status: 'pendiente', product_id: null, quantity: 1 };
    mercadopago.expirePreference = async () => { throw new Error('MP respondió 400'); };
    const order = { id: ORDER_ID, payment_method: 'mp', payment_status: 'pendiente', mp_preference_id: PREFERENCE_ID };
    assert.equal(await cancelMpOrder(order), 'cancelled');
  });

  test('cancelMpPurchases (carrito completo) expira la preferencia de las ventas canceladas', async () => {
    const order = {
      id: ORDER_ID, payment_method: 'mp', payment_status: 'pendiente', buyer_email: OWNER_EMAIL, mp_preference_id: PREFERENCE_ID,
    };
    state.orders = [order];
    const result = await cancelMpPurchases({ id: 'u-1', email: OWNER_EMAIL, role: 'user' }, [ORDER_ID]);
    assert.equal(result.forbidden, false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(expireCalls.map((call) => call.id), [PREFERENCE_ID]);
  });
});

describe('S-08: sin console.* en insights', () => {
  test('un error de consulta va al logger estructurado, no a console.error', async () => {
    const Insights = require(abs('models/Insights.js'));
    Insights.lowStock = async () => { throw Object.assign(new Error('boom'), { code: 'XX000' }); };
    const { getLowStock } = require(abs('controllers/insightsController.js'));
    const originalConsole = console.error;
    let consoleCalls = 0;
    console.error = () => { consoleCalls += 1; };
    let entries;
    try {
      entries = await captureLogs('error', async () => {
        const res = createRes();
        await getLowStock({ query: {} }, res);
        assert.equal(res.statusCode, 500);
        assert.equal(res.body.success, false);
        assert.equal(res.body.code, 'INSIGHT_FAILED');
      });
    } finally {
      console.error = originalConsole;
    }
    assert.equal(consoleCalls, 0);
    assert.equal(entries[0].message, 'insights_query_failed');
    assert.equal(entries[0].context.error, 'boom');
  });
});
