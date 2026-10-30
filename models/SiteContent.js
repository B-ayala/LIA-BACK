const { pool } = require('../config/database');

/** Contenido editable del sitio (tabla public.site_content): una fila JSON por clave. */
class SiteContent {
  /** Valor publicado para la clave, o `null` si todavía no se publicó nada. */
  static async get(key) {
    const { rows } = await pool.query(
      `SELECT value
         FROM public.site_content
        WHERE key = $1
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [key]
    );
    return rows[0] ? rows[0].value : null;
  }
}

module.exports = SiteContent;
