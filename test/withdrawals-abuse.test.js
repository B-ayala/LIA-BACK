const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeDatabase, startApp } = require('./helpers/harness');

// El rate limit es en memoria y por proceso: este archivo corre aislado para que el
// conteo por IP no se mezcle con el de test/withdrawals.test.js.
const IP_LIMIT = 10;
const EMAIL_LIMIT = 5;

installFakeDatabase((sql) => {
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

const submit = (email) => fetch(`${app.baseUrl}/api/withdrawals`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Ana', email, description: 'Campera' }),
});

test('NEGATIVO: el email se bloquea tras 5 solicitudes por hora y la IP tras 10 en 10 minutos', async () => {
  for (let attempt = 1; attempt <= EMAIL_LIMIT; attempt += 1) {
    assert.equal((await submit('spam@example.test')).status, 201, `solicitud ${attempt}`);
  }
  const blockedByEmail = await submit('spam@example.test');
  assert.equal(blockedByEmail.status, 429);
  assert.equal((await blockedByEmail.json()).code, 'RATE_LIMITED');

  // La IP ya acumula EMAIL_LIMIT + 1 hits: otros emails pasan hasta que la IP llega a su tope.
  for (let attempt = EMAIL_LIMIT + 2; attempt <= IP_LIMIT; attempt += 1) {
    assert.equal((await submit(`otro${attempt}@example.test`)).status, 201, `solicitud ${attempt}`);
  }
  assert.equal((await submit('ultimo@example.test')).status, 429);
});
