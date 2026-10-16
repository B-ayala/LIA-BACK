/**
 * Transacciones cortas sobre el pool de `pg`.
 *
 * Centraliza el patrón BEGIN / COMMIT / ROLLBACK para que ningún caller se
 * olvide de devolver la conexión, ni devuelva al pool una conexión rota: si el
 * ROLLBACK falla (socket cortado, statement_timeout del servidor), la conexión
 * se descarta con `release(error)` en vez de quedar envenenando al próximo que
 * la tome.
 *
 * `work(client)` puede devolver `rollbackWith(value)` para deshacer lo hecho sin
 * tratarlo como error (ej. stock insuficiente a mitad de un carrito).
 */

const logger = require('./logger');

const ROLLBACK_MARK = Symbol('rollback');

const rollbackWith = (value) => ({ [ROLLBACK_MARK]: true, value });

const isRollback = (result) => Boolean(result && result[ROLLBACK_MARK]);

/** ROLLBACK que nunca lanza. Devuelve el error si falló (la conexión hay que descartarla). */
const rollbackSafely = async (client, context) => {
  try {
    await client.query('ROLLBACK');
    return null;
  } catch (error) {
    logger.error('db_rollback_failed', { context, code: error.code, message: error.message });
    return error;
  }
};

const createTransactionRunner = (pool) => async (context, work) => {
  const client = await pool.connect();
  let brokenConnection = null;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    if (isRollback(result)) {
      brokenConnection = await rollbackSafely(client, context);
      return result.value;
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    brokenConnection = brokenConnection || (await rollbackSafely(client, context));
    throw error;
  } finally {
    client.release(brokenConnection || undefined);
  }
};

const withTransaction = (context, work) => {
  // Import diferido: los tests unitarios usan createTransactionRunner con un pool falso.
  const { pool } = require('../config/database');
  return createTransactionRunner(pool)(context, work);
};

module.exports = { withTransaction, rollbackWith, createTransactionRunner };
