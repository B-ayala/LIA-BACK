/**
 * S-10 / S-08: el store del rate limit tiene tope DURO de claves (con reloj inyectado), las IPv6 se agrupan por
 * /64 y el log de bloqueo no lleva la IP en claro.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { abs } = require('./helpers/harness');

const { SlidingWindowStore, createRateLimit, ipKey, MAX_TRACKED_KEYS } = require(abs('middleware/rateLimit.js'));
const logger = require(abs('utils/logger.js'));

const WINDOW_MS = 60 * 1000;
const FIVE_MINUTES_MS = 5 * 60 * 1000;

const createClock = (start = 1_700_000_000_000) => {
  const clock = { time: start, now: () => clock.time, advance: (ms) => { clock.time += ms; } };
  return clock;
};

describe('SlidingWindowStore: tope duro de claves', () => {
  test('el tope por defecto existe y es finito', () => {
    assert.ok(Number.isInteger(MAX_TRACKED_KEYS) && MAX_TRACKED_KEYS > 0);
  });

  test('nunca supera maxKeys aunque lleguen claves únicas sin parar (todas dentro de la ventana)', () => {
    const clock = createClock();
    const store = new SlidingWindowStore({ now: clock.now, maxKeys: 100 });
    for (let index = 0; index < 5000; index += 1) store.hit(`ip:${index}`, WINDOW_MS);
    assert.ok(store.size() <= 100, `size=${store.size()}`);
    clearInterval(store.timer);
  });

  test('al llenarse descarta la clave más antigua y conserva las nuevas', () => {
    const clock = createClock();
    const store = new SlidingWindowStore({ now: clock.now, maxKeys: 3 });
    ['a', 'b', 'c', 'd'].forEach((key) => store.hit(key, WINDOW_MS));
    assert.equal(store.buckets.has('a'), false);
    assert.deepEqual([...store.buckets.keys()], ['b', 'c', 'd']);
    clearInterval(store.timer);
  });

  test('antes de descartar, limpia lo vencido', () => {
    const clock = createClock();
    const store = new SlidingWindowStore({ now: clock.now, maxKeys: 3 });
    ['a', 'b', 'c'].forEach((key) => store.hit(key, WINDOW_MS));
    clock.advance(FIVE_MINUTES_MS + 2 * WINDOW_MS);
    store.hit('d', WINDOW_MS);
    assert.deepEqual([...store.buckets.keys()], ['d'], 'las vencidas se barrieron, no se expulsó a ninguna vigente');
    clearInterval(store.timer);
  });

  test('el barrido forzado por el tope no se repite en cada clave nueva (mínimo 1 s entre barridos)', () => {
    const clock = createClock();
    const store = new SlidingWindowStore({ now: clock.now, maxKeys: 5 });
    let sweeps = 0;
    const original = store.cleanup.bind(store);
    store.cleanup = () => { sweeps += 1; original(); };
    for (let index = 0; index < 200; index += 1) store.hit(`k${index}`, WINDOW_MS);
    assert.equal(sweeps, 1);
    clearInterval(store.timer);
  });

  test('el conteo de ventana deslizante sigue funcionando con el reloj inyectado', () => {
    const clock = createClock(Math.floor(1_700_000_000_000 / WINDOW_MS) * WINDOW_MS);
    const store = new SlidingWindowStore({ now: clock.now, maxKeys: 10 });
    for (let index = 0; index < 4; index += 1) store.hit('x', WINDOW_MS);
    clock.advance(WINDOW_MS);
    const { weighted } = store.hit('x', WINDOW_MS);
    assert.equal(weighted, 4 + 1, 'al inicio de la ventana siguiente pesa entero el tramo anterior');
    clearInterval(store.timer);
  });
});

describe('IPv6 agrupada por /64', () => {
  test('ipKey: mismas /64 → misma clave; distintas /64 → distinta; IPv4 y mapeadas se respetan', () => {
    assert.equal(ipKey('2001:db8:abcd:12::1'), ipKey('2001:db8:abcd:12:ffff:eeee:dddd:cccc'));
    assert.notEqual(ipKey('2001:db8:abcd:12::1'), ipKey('2001:db8:abcd:13::1'));
    assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
    assert.equal(ipKey('::ffff:203.0.113.9'), '203.0.113.9');
  });

  test('rotar el sufijo dentro de un /64 no da un contador nuevo por request', () => {
    const store = new SlidingWindowStore({ maxKeys: 100 });
    const limit = createRateLimit({ name: 'v6', windowMs: WINDOW_MS, max: 3, store });
    const statuses = [];
    const response = () => ({ setHeader() {}, status(code) { statuses.push(code); return this; }, json() { return this; } });
    for (let index = 1; index <= 6; index += 1) {
      limit({ method: 'GET', originalUrl: '/x', ip: `2001:db8:abcd:12::${index}` }, response(), () => statuses.push(200));
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
    assert.equal(store.size(), 1);
    clearInterval(store.timer);
  });
});

describe('log de bloqueo sin IP en claro', () => {
  test('rate_limit_blocked lleva hash y tipo de clave, no la IP ni el id de usuario', () => {
    const warnings = [];
    const original = logger.warn;
    logger.warn = (message, context) => warnings.push({ message, context });
    try {
      const store = new SlidingWindowStore({ maxKeys: 10 });
      const limit = createRateLimit({ name: 'log-test', windowMs: WINDOW_MS, max: 1, store });
      const response = { setHeader() {}, status() { return this; }, json() { return this; } };
      const request = { method: 'GET', originalUrl: '/api/x?email=a@b.c', ip: '198.51.100.77' };
      limit(request, response, () => undefined);
      limit(request, response, () => undefined);
      const userRequest = { method: 'GET', originalUrl: '/api/x', ip: '198.51.100.77', user: { id: 'user-secret-id' } };
      limit(userRequest, response, () => undefined);
      limit(userRequest, response, () => undefined);
      clearInterval(store.timer);
    } finally {
      logger.warn = original;
    }
    const blocked = warnings.filter((entry) => entry.message === 'rate_limit_blocked');
    assert.equal(blocked.length, 2);
    const serialized = JSON.stringify(blocked);
    assert.doesNotMatch(serialized, /198\.51\.100\.77/);
    assert.doesNotMatch(serialized, /user-secret-id/);
    assert.equal(blocked[0].context.keyKind, 'ip');
    assert.equal(blocked[1].context.keyKind, 'user');
    assert.match(blocked[0].context.keyHash, /^[0-9a-f]{12}$/);
    assert.notEqual(blocked[0].context.keyHash, blocked[1].context.keyHash);
  });

  test('una clave que no es ip ni usuario (ej. email) no se describe ni siquiera por su prefijo', () => {
    const warnings = [];
    const original = logger.warn;
    logger.warn = (message, context) => warnings.push({ message, context });
    try {
      const store = new SlidingWindowStore({ maxKeys: 10 });
      const limit = createRateLimit({
        name: 'email-test', windowMs: WINDOW_MS, max: 1, store, keyGenerator: () => 'victima@example.test',
      });
      const response = { setHeader() {}, status() { return this; }, json() { return this; } };
      limit({ method: 'POST', originalUrl: '/x' }, response, () => undefined);
      limit({ method: 'POST', originalUrl: '/x' }, response, () => undefined);
      clearInterval(store.timer);
    } finally {
      logger.warn = original;
    }
    assert.doesNotMatch(JSON.stringify(warnings), /victima@example\.test/);
    assert.equal(warnings[0].context.keyKind, 'other');
  });
});
