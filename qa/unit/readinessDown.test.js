const test = require('node:test');
const assert = require('node:assert/strict');
const { stubModule, abs } = require('../../test/helpers/harness');

process.env.LOG_LEVEL = 'error';

stubModule('config/database.js', {
  checkDatabase: async () => ({ ok: false, latencyMs: 2000, error: 'readiness timeout' }),
  getPoolStats: () => ({ total: 12, idle: 0, waiting: 40, max: 12 }),
});

const { getReadiness } = require(abs('services/readiness.js'));

test('readiness: si la base no responde a tiempo informa NO listo, con el pool saturado a la vista', async () => {
  const result = await getReadiness();
  assert.equal(result.ready, false);
  assert.equal(result.database.error, 'readiness timeout');
  assert.equal(result.pool.waiting, 40);
});
