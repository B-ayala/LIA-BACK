const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { abs } = require('./helpers/harness');

const loadPool = () => {
  delete require.cache[abs('config/database.js')];
  return require(abs('config/database.js')).pool;
};

describe('TLS hacia la base de datos (J)', () => {
  afterEach(() => { delete process.env.DB_SSL_CA; });

  test('POSITIVO: con DB_SSL_CA se valida el certificado del servidor', () => {
    process.env.DB_SSL_CA = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
    const { ssl } = loadPool().options;
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.ca, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----');
  });

  test('sin DB_SSL_CA se mantiene el comportamiento anterior (cifrado sin validar la CA)', () => {
    const { ssl } = loadPool().options;
    assert.equal(ssl.rejectUnauthorized, false);
    assert.equal(ssl.ca, undefined);
  });
});
