const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');

// Antes de cargar el middleware: carril de checkout minúsculo y sin cola.
process.env.BULKHEAD_CHECKOUT_MAX = '2';
process.env.BULKHEAD_CHECKOUT_QUEUE = '0';
process.env.LOG_LEVEL = 'error';
const { concurrencyLimit, concurrencyStats } = require('../../middleware/concurrencyLimit');

const held = [];
const app = express();
app.use('/api', concurrencyLimit);
app.post('/api/orders/transfer', (req, res) => { held.push(res); });
app.post('/api/orders/mp-webhook', (req, res) => res.json({ ok: true }));
app.get('/api/products', (req, res) => res.json({ ok: true }));

const send = (port, method, path) => new Promise((resolve, reject) => {
  const request = http.request({ port, method, path, agent: false }, (response) => {
    let data = '';
    response.on('data', (chunk) => { data += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: data ? JSON.parse(data) : null }));
  });
  request.on('error', reject);
  request.end();
});

const until = async (predicate) => {
  for (let i = 0; i < 100 && !predicate(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), 'condición no alcanzada');
};

test('un carril de checkout saturado responde 503 SERVER_BUSY sin afectar al catálogo ni al webhook', async () => {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const { port } = server.address();
  try {
    const pending = [send(port, 'POST', '/api/orders/transfer'), send(port, 'POST', '/api/orders/transfer')];
    await until(() => held.length === 2);
    assert.equal(concurrencyStats().checkout.active, 2);

    const shed = await send(port, 'POST', '/api/orders/transfer');
    assert.equal(shed.status, 503);
    assert.equal(shed.body.code, 'SERVER_BUSY');
    assert.ok(shed.headers['retry-after']);

    assert.equal((await send(port, 'GET', '/api/products')).status, 200, 'el catálogo sigue respondiendo');
    assert.equal((await send(port, 'POST', '/api/orders/mp-webhook')).status, 200, 'el webhook tiene su propio carril');

    held.forEach((res) => res.json({ ok: true }));
    await Promise.all(pending);
    await until(() => concurrencyStats().checkout.active === 0);
  } finally {
    held.forEach((res) => { if (!res.writableEnded) res.end(); });
    server.close();
  }
});
