const test = require('node:test');
const assert = require('node:assert/strict');
const { stubModule, abs } = require('../../test/helpers/harness');

process.env.LOG_LEVEL = 'error';

let dbCalls = 0;
let dbResult = { ok: true, latencyMs: 3 };
stubModule('config/database.js', {
  checkDatabase: async () => { dbCalls += 1; return dbResult; },
  getPoolStats: () => ({ total: 2, idle: 2, waiting: 0, max: 12 }),
});

const { getReadiness } = require(abs('services/readiness.js'));

test('readiness: con la base respondiendo informa listo y el estado del pool', async () => {
  const result = await getReadiness();
  assert.equal(result.ready, true);
  assert.equal(result.pool.max, 12);
});

test('readiness: el resultado se memoriza y las llamadas en ráfaga no multiplican las consultas', async () => {
  const before = dbCalls;
  await Promise.all([getReadiness(), getReadiness(), getReadiness()]);
  assert.equal(dbCalls - before, 0, 'se sirve del resultado ya memorizado');
});
