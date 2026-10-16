const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { installFakeDatabase, createRes, abs } = require('./helpers/harness');

const WEBHOOK_SECRET = 'whsec-test-secret';
process.env.MP_ACCESS_TOKEN = 'APP_USR-test-token';
process.env.MP_WEBHOOK_SECRET = WEBHOOK_SECRET;

const pool = installFakeDatabase();
const mercadopago = require(abs('utils/mercadopago.js'));
const Order = require(abs('models/Order.js'));
const { mpWebhook, confirmMpPayment } = require(abs('controllers/orderController.js'));

const ORDER_ID = '11111111-1111-4111-8111-111111111111';

const sign = (dataId, { requestId = 'req-1', ts = '1700000000', secret = WEBHOOK_SECRET } = {}) => {
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId };
};

const webhookReq = (dataId, headers) => ({
  query: { type: 'payment', 'data.id': String(dataId) },
  headers,
  body: {},
});

let getPaymentCalls;
let markPaidCalls;

const approvedPayment = (overrides = {}) => ({
  status: 'approved',
  external_reference: ORDER_ID,
  transaction_amount: 5000,
  currency_id: 'ARS',
  ...overrides,
});

const stubPayments = (payment) => {
  getPaymentCalls = [];
  markPaidCalls = [];
  mercadopago.getPayment = async (id) => { getPaymentCalls.push(String(id)); return payment; };
  Order.markPaidByIds = async (ids, amount) => { markPaidCalls.push({ ids, amount }); return ids.length; };
};

describe('Webhook de Mercado Pago (prueba 6 y 7)', () => {
  beforeEach(() => stubPayments(approvedPayment()));

  test('NEGATIVO: firma inválida se rechaza con 401 y no consulta ni toca nada', async () => {
    const res = createRes();
    await mpWebhook(webhookReq(123456, sign(123456, { secret: 'otra-clave' })), res);
    assert.equal(res.statusCode, 401);
    assert.equal(getPaymentCalls.length, 0);
    assert.equal(markPaidCalls.length, 0);
  });

  test('NEGATIVO: sin cabecera de firma se rechaza con 401', async () => {
    const res = createRes();
    await mpWebhook(webhookReq(123456, {}), res);
    assert.equal(res.statusCode, 401);
    assert.equal(markPaidCalls.length, 0);
  });

  test('NEGATIVO: firma válida de OTRO pago no sirve para el id notificado', async () => {
    const res = createRes();
    await mpWebhook(webhookReq(999, sign(123456)), res);
    assert.equal(res.statusCode, 401);
    assert.equal(markPaidCalls.length, 0);
  });

  test('POSITIVO: firma válida + pago aprobado marca la orden con el monto que informa MP', async () => {
    const res = createRes();
    await mpWebhook(webhookReq(123456, sign(123456)), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(getPaymentCalls, ['123456']);
    assert.deepEqual(markPaidCalls, [{ ids: [ORDER_ID], amount: 5000 }]);
  });

  test('NEGATIVO: pago pendiente no salda la orden', async () => {
    stubPayments(approvedPayment({ status: 'pending' }));
    const res = createRes();
    await mpWebhook(webhookReq(123456, sign(123456)), res);
    assert.equal(res.statusCode, 200);
    assert.equal(markPaidCalls.length, 0);
  });

  test('NEGATIVO: pago aprobado en otra moneda no salda la orden', async () => {
    stubPayments(approvedPayment({ currency_id: 'USD' }));
    const res = createRes();
    await mpWebhook(webhookReq(123456, sign(123456)), res);
    assert.equal(res.statusCode, 200);
    assert.equal(markPaidCalls.length, 0);
  });

  test('NEGATIVO: id de pago no numérico firmado correctamente no llega a la API de MP', async () => {
    const res = createRes();
    await mpWebhook(webhookReq('../../users/me', sign('../../users/me')), res);
    assert.equal(res.statusCode, 200);
    assert.equal(getPaymentCalls.length, 0);
  });
});

describe('mp-confirm: el navegador no decide si se pagó (prueba 5)', () => {
  const confirmReq = (paymentId) => ({ body: { paymentId } });

  test('NEGATIVO: pago que MP no aprobó responde 409 y no marca pagado', async () => {
    stubPayments(approvedPayment({ status: 'rejected' }));
    const res = createRes();
    await confirmMpPayment(confirmReq('123456'), res);
    assert.equal(res.statusCode, 409);
    assert.equal(markPaidCalls.length, 0);
  });

  test('NEGATIVO: paymentId con formato inválido responde 400 sin consultar a MP', async () => {
    stubPayments(approvedPayment());
    const res = createRes();
    await confirmMpPayment(confirmReq({ $ne: null }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(getPaymentCalls.length, 0);
  });

  test('NEGATIVO: moneda distinta de ARS responde 409', async () => {
    stubPayments(approvedPayment({ currency_id: 'USD' }));
    const res = createRes();
    await confirmMpPayment(confirmReq('123456'), res);
    assert.equal(res.statusCode, 409);
    assert.equal(markPaidCalls.length, 0);
  });

  test('POSITIVO: pago aprobado verificado contra MP salda la orden', async () => {
    stubPayments(approvedPayment());
    const res = createRes();
    await confirmMpPayment(confirmReq('123456'), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(markPaidCalls, [{ ids: [ORDER_ID], amount: 5000 }]);
  });
});

describe('Order.markPaidByIds: monto e idempotencia (prueba 7)', () => {
  const realMarkPaid = Order.markPaidByIds;
  const lastTx = () => pool.queries.map((q) => q.sql);

  const withRows = (rows, total) => {
    pool.queries.length = 0;
    pool.query = async () => ({ rows: [], rowCount: 0 });
    pool.connect = async () => ({
      release: () => undefined,
      query: async (sql, params) => {
        pool.queries.push({ sql, params });
        if (sql.startsWith('SELECT * FROM public.ventas')) return { rows };
        if (sql.includes('SUM(total_price)')) return { rows: [{ total }] };
        return { rows: [], rowCount: 0 };
      },
    });
    Order.markPaidByIds = realMarkPaid;
  };

  const updates = () => lastTx().filter((sql) => sql.startsWith('UPDATE'));

  test('NEGATIVO: webhook repetido sobre una orden ya pagada no actualiza ni toca el stock', async () => {
    withRows([{ id: ORDER_ID, payment_status: 'pagado', product_id: 7, quantity: 2 }], 5000);
    assert.equal(await Order.markPaidByIds([ORDER_ID], 5000, 1), 1);
    assert.deepEqual(updates(), []);
  });

  test('NEGATIVO: un pago por menos del total no salda la orden (-1, sin UPDATE)', async () => {
    withRows([{ id: ORDER_ID, payment_status: 'pendiente', product_id: 7, quantity: 2 }], 5000);
    assert.equal(await Order.markPaidByIds([ORDER_ID], 100, 1), -1);
    assert.deepEqual(updates(), []);
  });

  test('POSITIVO: orden pendiente con el monto correcto pasa a pagado una sola vez, sin tocar stock', async () => {
    withRows([{ id: ORDER_ID, payment_status: 'pendiente', product_id: 7, quantity: 2 }], 5000);
    assert.equal(await Order.markPaidByIds([ORDER_ID], 5000, 1), 1);
    const sent = updates();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /payment_status = 'pagado'/);
  });
});
