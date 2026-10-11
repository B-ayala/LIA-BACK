const { pool } = require('../config/database');

/**
 * Acceso a datos de respuestas idempotentes (tabla public.idempotency_keys).
 * `scope` ya incluye tipo de operación y usuario (ver utils/idempotency.js).
 */
class IdempotencyKey {
  /**
   * Respuesta guardada y todavía vigente para (scope, key), o null.
   * @returns {Promise<{fingerprint: string, status: number, body: object} | null>}
   */
  static async findFresh(scope, key, ttlSeconds) {
    const result = await pool.query(
      `SELECT fingerprint, status, body
         FROM public.idempotency_keys
        WHERE scope = $1 AND key = $2
          AND created_at > NOW() - make_interval(secs => $3)`,
      [scope, key, ttlSeconds]
    );
    return result.rows[0] || null;
  }

  /** Guarda (o reemplaza una fila vencida de) la respuesta de una key. */
  static async save(scope, key, { fingerprint, status, body }) {
    await pool.query(
      `INSERT INTO public.idempotency_keys (scope, key, fingerprint, status, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (scope, key) DO UPDATE
         SET fingerprint = EXCLUDED.fingerprint,
             status = EXCLUDED.status,
             body = EXCLUDED.body,
             created_at = NOW()`,
      [scope, key, fingerprint, status, JSON.stringify(body)]
    );
  }

  /** Borra filas más viejas que `hours`. Devuelve cuántas. */
  static async purgeOlderThan(hours) {
    const result = await pool.query(
      `DELETE FROM public.idempotency_keys
        WHERE created_at < NOW() - make_interval(hours => $1)`,
      [hours]
    );
    return result.rowCount;
  }
}

module.exports = IdempotencyKey;
