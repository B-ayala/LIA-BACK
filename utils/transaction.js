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
const { isUuid } = require('./uuid');

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

/**
 * Atribuye los cambios de la transacción en curso a un usuario (`audit_log.actor`).
 * El backend conecta como `postgres`, así que `auth.uid()` es NULL; el trigger de
 * auditoría lee este valor local (`set_config(..., true)` solo dura hasta el
 * COMMIT/ROLLBACK, no queda en la conexión del pool). Solo se acepta un uuid: un
 * id mal formado rompería el cast del trigger y abortaría la escritura auditada.
 */
const setTransactionActor = async (client, actor) => {
  if (!isUuid(actor)) return;
  await client.query("SELECT set_config('app.actor', $1, true)", [String(actor).toLowerCase()]);
};

const createTransactionRunner = (pool) => async (context, work, { actor = null } = {}) => {
  const client = await pool.connect();
  let brokenConnection = null;
  try {
    await client.query('BEGIN');
    await setTransactionActor(client, actor);
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

const withTransaction = (context, work, options) => {
  // Import diferido: los tests unitarios usan createTransactionRunner con un pool falso.
  const { pool } = require('../config/database');
  return createTransactionRunner(pool)(context, work, options);
};

module.exports = { withTransaction, rollbackWith, createTransactionRunner, setTransactionActor };
