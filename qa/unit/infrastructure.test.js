const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransactionRunner, rollbackWith } = require('../../utils/transaction');
const { mapWithConcurrency } = require('../../utils/concurrency');
const { createLookupRotation } = require('../../utils/lookupRotation');
const { isUuid } = require('../../utils/uuid');

const fakePool = ({ failOn = null } = {}) => {
  const log = { queries: [], released: [] };
  const client = {
    query: async (sql) => {
      log.queries.push(sql);
      if (failOn && sql === failOn) throw Object.assign(new Error(`fail ${sql}`), { code: 'X' });
      return { rows: [] };
    },
    release: (error) => log.released.push(error),
  };
  return { pool: { connect: async () => client }, log };
};

test('transacción: COMMIT y release normal', async () => {
  const { pool, log } = fakePool();
  const result = await createTransactionRunner(pool)('t', async () => 42);
  assert.equal(result, 42);
  assert.deepEqual(log.queries, ['BEGIN', 'COMMIT']);
  assert.deepEqual(log.released, [undefined]);
});

test('transacción: lockTimeoutMs fija lock_timeout local antes del trabajo', async () => {
  const { pool, log } = fakePool();
  await createTransactionRunner(pool)('t', async () => 1, { lockTimeoutMs: 3000 });
  assert.deepEqual(log.queries, ['BEGIN', "SELECT set_config('lock_timeout', $1, true)", 'COMMIT']);
});

test('transacción: rollbackWith deshace sin lanzar y devuelve el valor', async () => {
  const { pool, log } = fakePool();
  const result = await createTransactionRunner(pool)('t', async () => rollbackWith({ ok: false }));
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(log.queries, ['BEGIN', 'ROLLBACK']);
});

test('transacción: un error hace ROLLBACK y se propaga', async () => {
  const { pool, log } = fakePool();
  await assert.rejects(createTransactionRunner(pool)('t', async () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(log.queries, ['BEGIN', 'ROLLBACK']);
  assert.deepEqual(log.released, [undefined]);
});

test('transacción: si el ROLLBACK falla la conexión se descarta (release con error)', async () => {
  const { pool, log } = fakePool({ failOn: 'ROLLBACK' });
  await assert.rejects(createTransactionRunner(pool)('t', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(log.released.length, 1);
  assert.ok(log.released[0] instanceof Error);
});

test('mapWithConcurrency respeta el límite y el orden de resultados', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    await Promise.resolve();
    active -= 1;
    return value * 10;
  });
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60]);
  assert.equal(peak, 2);
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
});

test('rotación: primero las nunca consultadas, después las más viejas; respeta el intervalo mínimo', () => {
  const rotation = createLookupRotation({ minIntervalMs: 5 * 60 * 1000 });
  const now = 10 * 60 * 1000;
  rotation.markChecked('a', now - 9 * 60 * 1000);
  rotation.markChecked('b', now - 6 * 60 * 1000);
  rotation.markChecked('c', now - 1 * 60 * 1000);
  assert.deepEqual(rotation.pick(['a', 'b', 'c', 'd', 'e'], 3, now), ['d', 'e', 'a']);
  assert.deepEqual(rotation.pick(['c'], 3, now), []);
  rotation.forget('c');
  assert.deepEqual(rotation.pick(['c'], 3, now), ['c']);
});

test('rotación: poda entradas viejas y tiene tope de memoria', () => {
  const rotation = createLookupRotation({ maxEntries: 2 });
  rotation.markChecked('a', 1);
  rotation.markChecked('b', 2);
  rotation.markChecked('c', 3);
  assert.equal(rotation.size(), 2);
  rotation.pruneOlderThan(10, 100);
  assert.equal(rotation.size(), 0);
});

test('isUuid', () => {
  assert.equal(isUuid('3f2b8c1e-9d4a-4b7e-8f00-123456789abc'), true);
  for (const bad of ['1', '', null, 5, '3f2b8c1e-9d4a-4b7e-8f00-123456789abc,1', "x' OR 1=1"]) {
    assert.equal(isUuid(bad), false, String(bad));
  }
});
