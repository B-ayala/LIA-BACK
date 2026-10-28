const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, startApp } = require('./helpers/harness');

// El rate limit por IP es en memoria y por proceso (10 por 10 min): estos casos viven en su
// propio archivo para no compartir el conteo de test/withdrawals.test.js.
const VENTA_ID = '22222222-2222-4222-8222-222222222222';
const BUYER_EMAIL = 'ana@example.test';
const UNKNOWN_ORDER = 9999;

const pool = installFakeDatabase((sql, params) => {
  if (sql.includes('FROM public.ventas') && sql.includes('LOWER(buyer_email)')) {
    // Un pedido inexistente no coincide por filtros, pero el email sí tiene compras.
    return { rows: params[0] === BUYER_EMAIL && params[1] !== UNKNOWN_ORDER ? [{ id: VENTA_ID }] : [] };
  }
  if (sql.startsWith('INSERT INTO public.withdrawal_requests')) {
    return { rows: [{ code: 'ARR-2026-0001', created_at: '2026-10-27T10:00:00Z' }] };
  }
  return undefined;
});

let app;
before(async () => {
  app = await startApp([['/api/withdrawals', 'routes/withdrawalRoutes.js']]);
});
after(() => app.close());
beforeEach(() => { pool.queries.length = 0; });

const submit = (overrides) => fetch(`${app.baseUrl}/api/withdrawals`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Ana', email: BUYER_EMAIL, description: 'Campera negra', ...overrides }),
});

const inserted = () => pool.queries.find((query) => query.sql.startsWith('INSERT INTO public.withdrawal_requests'));

test('sin N° de pedido: se acepta, se vinculan las compras del email y se marca para revisión', async () => {
  const response = await submit({});
  assert.equal(response.status, 201);
  const { params } = inserted();
  assert.deepEqual(params[6], [VENTA_ID]);
  assert.equal(params[7], true);
});

test('pedido que no coincide: cae al email, vincula las candidatas y marca revisión', async () => {
  const response = await submit({ orderNumber: UNKNOWN_ORDER });
  assert.equal(response.status, 201);
  const { params } = inserted();
  assert.deepEqual(params[6], [VENTA_ID]);
  assert.equal(params[7], true);
});

test('fecha e importe opcionales viajan al cruce y al registro', async () => {
  await submit({ purchaseDate: '2026-10-06', purchaseAmount: '15000.50' });
  const match = pool.queries.find((query) => query.sql.includes('LOWER(buyer_email)'));
  assert.equal(match.params[2], '2026-10-06');
  const { params } = inserted();
  assert.equal(params[4], '2026-10-06');
  assert.equal(params[5], 15000.5);
});

test('NEGATIVO: fecha inexistente, futura o importe no positivo responden 400 y no tocan la base', async () => {
  for (const overrides of [{ purchaseDate: '2026-02-31' }, { purchaseDate: '2999-01-01' }, { purchaseAmount: -5 }]) {
    assert.equal((await submit(overrides)).status, 400, JSON.stringify(overrides));
  }
  assert.equal(pool.queries.length, 0);
});
