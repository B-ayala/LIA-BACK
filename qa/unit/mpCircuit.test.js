const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, stubModule, abs } = require('../../test/helpers/harness');

// El circuito vive en el módulo de Mercado Pago: este archivo corre en su propio
// proceso y los tests dependen del orden (cada uno parte del estado que dejó el anterior).
process.env.MP_ACCESS_TOKEN = 'APP_USR-test-token';
process.env.LOG_LEVEL = 'error';

installFakeDatabase();

const reserveCalls = [];
stubModule('services/checkoutReservation.js', {
  reserveOrders: async (input) => { reserveCalls.push(input); return { ok: false, status: 409, code: 'OUT_OF_STOCK', message: 'x' }; },
  releaseOrders: async () => undefined,
});

const mercadopago = require(abs('utils/mercadopago.js'));
const { buildMpCheckout } = require(abs('services/checkout.js'));

let fetchCalls;
let fetchBehavior;
global.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), method: options.method || 'GET' });
  const { status, json, throwError } = fetchBehavior(fetchCalls.length);
  if (throwError) throw throwError;
  return { ok: status >= 200 && status < 300, status, json: async () => json };
};

const reset = (behavior) => { fetchCalls = []; fetchBehavior = behavior; };
const timeout = () => ({ throwError: Object.assign(new Error('t'), { name: 'TimeoutError' }) });

test('lectura: un 503 rápido se reintenta una vez y el reintento exitoso devuelve el pago', async () => {
  reset((n) => (n === 1 ? { status: 503, json: { message: 'caído' } } : { status: 200, json: { id: 1, status: 'approved' } }));
  const payment = await mercadopago.getPayment('123');
  assert.equal(payment.status, 'approved');
  assert.equal(fetchCalls.length, 2);
});

test('lectura: un 404 no se reintenta y no cuenta como caída de MP', async () => {
  reset(() => ({ status: 404, json: { message: 'not found' } }));
  const error = await mercadopago.getPayment('999').catch((e) => e);
  assert.equal(error.status, 404);
  assert.equal(fetchCalls.length, 1);
  assert.equal(mercadopago.circuitState(), 'closed');
});

test('lectura: un timeout NO se reintenta (ya consumió la espera completa)', async () => {
  reset(() => timeout());
  const error = await mercadopago.getPayment('123').catch((e) => e);
  assert.equal(error.code, 'MP_TIMEOUT');
  assert.equal(fetchCalls.length, 1);
});

test('escritura: crear una preferencia NUNCA se reintenta', async () => {
  reset(() => ({ status: 503, json: {} }));
  await mercadopago.createPreference({ items: [] }).catch(() => undefined);
  assert.equal(fetchCalls.length, 1);
  assert.equal(mercadopago.circuitState(), 'closed', 'dos fallas seguidas todavía no abren el circuito');
});

test('cinco caídas seguidas abren el circuito: la siguiente llamada falla al instante sin tocar la red', async () => {
  reset(() => ({ status: 503, json: {} }));
  for (let i = 0; i < 3; i += 1) await mercadopago.createPreference({ items: [] }).catch(() => undefined);
  assert.equal(mercadopago.circuitState(), 'open');
  assert.equal(mercadopago.isAvailable(), false);
  assert.ok(mercadopago.retryAfterSeconds() >= 1);

  fetchCalls = [];
  const error = await mercadopago.getPayment('123').catch((e) => e);
  assert.equal(error.code, 'CIRCUIT_OPEN');
  assert.equal(fetchCalls.length, 0);
});

test('checkout con el circuito abierto: 502 MP_UNAVAILABLE ANTES de reservar stock', async () => {
  reserveCalls.length = 0;
  const result = await buildMpCheckout({ buyerName: 'Ana', buyerEmail: 'ana@example.test', items: [] });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, 'MP_UNAVAILABLE');
  assert.match(result.body.message, /transferencia/);
  assert.equal(reserveCalls.length, 0, 'no se reservó stock');
});
