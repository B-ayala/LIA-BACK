// Readiness: ¿esta instancia puede servir tráfico real? (liveness es /health.)
//
// El resultado se memoriza unos segundos: un monitor externo o un script que
// golpee /ready en bucle no debe convertirse en un `SELECT 1` por request que
// compita por las conexiones del pool con los usuarios.

const { checkDatabase, getPoolStats } = require('../config/database');
const { TtlCache } = require('../utils/cache');

const READINESS_CACHE_MS = 3000;
const CACHE_KEY = 'database';

const cache = new TtlCache({ name: 'readiness', maxEntries: 1 });

const loadReadiness = async () => {
  const database = await checkDatabase();
  return { ready: database.ok, database, pool: getPoolStats() };
};

/** @returns {Promise<{ready: boolean, database: {ok: boolean, latencyMs: number, error?: string}, pool: object}>} */
const getReadiness = () => cache.getOrSet(CACHE_KEY, READINESS_CACHE_MS, loadReadiness);

module.exports = { getReadiness };
