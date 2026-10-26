const { pool } = require('../config/database');

const UNIQUE_VIOLATION = '23505';

const COLUMNS = 'id, name, type, measurements, active, created_at, updated_at';

const keep = (value) => value;

const UPDATABLE_COLUMNS = [
  ['name', 'name', keep],
  ['type', 'type', keep],
  ['measurements', 'measurements', JSON.stringify],
  ['active', 'active', keep],
];

const toSize = (row) => ({
  id: row.id,
  name: row.name,
  type: row.type,
  measurements: row.measurements,
  active: row.active,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// El duplicado (type + lower(name)) lo detecta el índice único y no un SELECT previo: no hay carrera entre dos admins.
const runWrite = async (text, values) => {
  try {
    const result = await pool.query(text, values);
    return result.rows[0] ? { status: 'ok', size: toSize(result.rows[0]) } : { status: 'not_found' };
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) return { status: 'duplicate' };
    throw error;
  }
};

/** Acceso a datos del catálogo de talles (tabla public.talles). */
class Size {
  static async findAll() {
    const result = await pool.query(`SELECT ${COLUMNS} FROM public.talles ORDER BY type, name`);
    return result.rows.map(toSize);
  }

  /** @returns {Promise<string[]>} ids de la lista que NO existen en el catálogo (una sola query). */
  static async findMissingIds(ids) {
    if (ids.length === 0) return [];
    const result = await pool.query('SELECT id FROM public.talles WHERE id = ANY($1::uuid[])', [ids]);
    const found = new Set(result.rows.map((row) => row.id));
    return ids.filter((id) => !found.has(id));
  }

  /** @returns {Promise<{status: 'ok', size: object} | {status: 'duplicate'}>} */
  static async create({ name, type, measurements = {} }) {
    return runWrite(
      `INSERT INTO public.talles (name, type, measurements) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [name, type, JSON.stringify(measurements)]
    );
  }

  /** @returns {Promise<{status: 'ok', size: object} | {status: 'duplicate'|'not_found'|'empty'}>} */
  static async update(id, body) {
    const present = UPDATABLE_COLUMNS.filter(([field]) => body[field] !== undefined);
    if (present.length === 0) return { status: 'empty' };

    const sets = present.map(([, column], index) => `${column} = $${index + 1}`);
    const values = present.map(([field, , convert]) => convert(body[field]));
    values.push(id);
    return runWrite(
      `UPDATE public.talles SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${COLUMNS}`,
      values
    );
  }
}

module.exports = Size;
