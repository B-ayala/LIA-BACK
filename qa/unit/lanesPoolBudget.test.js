const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';
const {
  Bulkhead, acquireLane, generalGroup, lanes, laneFor,
} = require('../../middleware/concurrencyLimit');

const DEFAULT_POOL_MAX = 12;
const CRITICAL_RESERVE = 5;

test('H-01: los carriles generales comparten un presupuesto de conexiones = pool - reserva crítica', () => {
  assert.equal(generalGroup.maxConcurrent, DEFAULT_POOL_MAX - CRITICAL_RESERVE);
  for (const name of ['read', 'auth', 'admin']) assert.equal(lanes[name].group, generalGroup, name);
  for (const name of ['checkout', 'local', 'webhook']) assert.equal(lanes[name].group, null, name);
});

test('H-01: el carril de lectura quedó entre 6 y 8 y ninguno de los generales supera el presupuesto', () => {
  assert.ok(lanes.read.maxConcurrent >= 6 && lanes.read.maxConcurrent <= 8);
  for (const name of ['read', 'auth', 'admin']) assert.ok(lanes[name].maxConcurrent <= generalGroup.maxConcurrent);
});

test('H-01: lo que no es general no puede ser agotado por lecturas, auth y admin juntos', async () => {
  const releases = [];
  const budget = generalGroup.maxConcurrent;
  generalGroup.maxQueue = 0;
  try {
    // Lecturas hasta su tope y el resto del presupuesto con auth: el grupo queda lleno sin llenar el carril de admin.
    for (let index = 0; index < lanes.read.maxConcurrent; index += 1) releases.push(await acquireLane(lanes.read));
    for (let index = releases.length; index < budget; index += 1) releases.push(await acquireLane(lanes.auth));
    assert.equal(releases.length, budget);
    assert.ok(releases.every((release) => typeof release === 'function'));

    assert.equal(await acquireLane(lanes.admin), null, 'el grupo general lleno rechaza admin');
    assert.equal(lanes.admin.active, 0, 'y no deja tomado el slot del carril');

    const critical = await Promise.all([lanes.checkout, lanes.local, lanes.webhook].map(acquireLane));
    assert.ok(critical.every((release) => typeof release === 'function'), 'checkout, local y webhook siguen entrando');
    critical.forEach((release) => release());
  } finally {
    releases.forEach((release) => release());
    generalGroup.maxQueue = 100;
  }
  assert.equal(generalGroup.active, 0);
  assert.equal(lanes.read.active, 0);
});

test('Bulkhead con grupo: liberar devuelve el slot del carril Y el del grupo', async () => {
  const group = new Bulkhead({ name: 'g', maxConcurrent: 1, maxQueue: 0, queueTimeoutMs: 50 });
  const lane = new Bulkhead({ name: 'l', maxConcurrent: 3, maxQueue: 0, queueTimeoutMs: 50, group });
  const release = await acquireLane(lane);
  assert.equal(group.active, 1);
  assert.equal(lane.active, 1);
  assert.equal(await acquireLane(lane), null);
  release();
  assert.equal(group.active, 0);
  assert.equal(lane.active, 0);
  assert.equal(typeof (await acquireLane(lane)), 'function');
});

test('H-05: transferencia y nudge tienen carril propio; lo que llama a MP sigue en checkout', () => {
  assert.equal(laneFor('POST', '/orders/transfer'), 'local');
  assert.equal(laneFor('POST', '/orders/nudge'), 'local');
  for (const path of ['/orders/mp-preference', '/orders/mp-confirm', '/orders/mp-cancel', '/orders/abc/cancel']) {
    assert.equal(laneFor('POST', path), 'checkout', path);
  }
  assert.notEqual(lanes.local, lanes.checkout);
});

test('H-05: saturar el carril de MP no consume cupos de transferencia', async () => {
  const held = [];
  lanes.checkout.maxQueue = 0;
  for (let index = 0; index < lanes.checkout.maxConcurrent; index += 1) held.push(await acquireLane(lanes.checkout));
  assert.equal(await acquireLane(lanes.checkout), null);
  const local = await acquireLane(lanes.local);
  assert.equal(typeof local, 'function');
  [...held, local].forEach((release) => release());
});
