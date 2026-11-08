/**
 * Base en memoria con la semántica que importa del checkout: transacciones con rollback real,
 * lock de fila por producto (FOR UPDATE), advisory lock por usuario, índice único parcial
 * `(user_id, idempotency_key)` (23505) y el trigger que descuenta stock al insertar una venta.
 * No ejecuta SQL: reconoce las consultas por fragmentos, igual que el resto de los dobles del repo.
 */

const UNIQUE_VIOLATION = '23505';

class Mutex {
  constructor() { this.tail = Promise.resolve(); }

  /** @returns {Promise<() => void>} función que libera el lock */
  async acquire() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = this.tail.then(() => next);
    await previous;
    return release;
  }
}

const createFakeCheckoutDb = ({ stock = 1000, productId = '7' } = {}) => {
  const state = {
    product: { id: productId, stock, price: 1000, name: 'Remera', status: 'active', variants: null },
    ventas: [],
    sequence: 0,
    hideIdempotencyLookups: 0,
    queries: [],
  };
  const productLock = new Mutex();
  const userLocks = new Map();
  let nextId = 0;

  const userMutex = (userId) => {
    if (!userLocks.has(userId)) userLocks.set(userId, new Mutex());
    return userLocks.get(userId);
  };

  const insertVenta = (tx, params) => {
    const row = {
      id: `order-${(nextId += 1)}`, buyer_name: params[0], user_id: params[2], product_id: params[3], quantity: params[6],
      payment_method: params[10], payment_status: 'pendiente', order_number: params[13], idempotency_key: params[14] ?? null,
      mp_external_reference: params[12], units_config: params[9],
    };
    const clash = row.idempotency_key && state.ventas.some(
      (v) => v.user_id === row.user_id && v.idempotency_key === row.idempotency_key
    );
    if (clash) throw Object.assign(new Error('duplicate key value'), { code: UNIQUE_VIOLATION });
    state.ventas.push(row);
    state.product.stock -= row.quantity; // trigger trg_decrement_stock
    tx.undo.push(() => {
      state.ventas.splice(state.ventas.indexOf(row), 1);
      state.product.stock += row.quantity;
    });
    return { rows: [{ id: row.id }], rowCount: 1 };
  };

  const setKeyNull = (tx, ids) => {
    for (const row of state.ventas.filter((v) => ids.includes(v.id))) {
      const previous = row.idempotency_key;
      row.idempotency_key = null;
      tx.undo.push(() => { row.idempotency_key = previous; });
    }
    return { rows: [], rowCount: ids.length };
  };

  const setStatus = (tx, id, status) => {
    const row = state.ventas.find((v) => v.id === id);
    const previous = row.payment_status;
    row.payment_status = status;
    tx.undo.push(() => { row.payment_status = previous; });
  };

  const finish = (tx, commit) => {
    if (!commit) tx.undo.reverse().forEach((undo) => undo());
    tx.undo = [];
    tx.releases.splice(0).forEach((release) => release());
  };

  // eslint-disable-next-line complexity
  const handle = async (tx, sql, params) => {
    if (sql === 'BEGIN') return undefined;
    if (sql === 'COMMIT') { finish(tx, true); return undefined; }
    if (sql === 'ROLLBACK') { finish(tx, false); return undefined; }
    if (sql.includes('pg_advisory_xact_lock')) {
      tx.releases.push(await userMutex(params[1]).acquire());
      return undefined;
    }
    if (sql.includes('FROM public.productos') && sql.includes('FOR UPDATE')) {
      if (!tx.holdsProduct) { tx.releases.push(await productLock.acquire()); tx.holdsProduct = true; }
      return { rows: [{ ...state.product }] };
    }
    if (sql.includes("payment_status = 'pendiente'") && sql.includes('COUNT(*)') && sql.includes('user_id')) {
      const mine = state.ventas.filter((v) => v.user_id === params[0] && v.payment_status === 'pendiente');
      return { rows: [{ pending: mine.length, units: mine.reduce((sum, v) => sum + v.quantity, 0) }] };
    }
    if (sql.includes('ventas_order_number_seq')) { state.sequence += 1; return { rows: [{ order_number: state.sequence }] }; }
    if (sql.includes('starts_with(idempotency_key')) {
      if (state.hideIdempotencyLookups > 0) { state.hideIdempotencyLookups -= 1; return { rows: [] }; }
      return { rows: state.ventas.filter((v) => v.user_id === params[0] && String(v.idempotency_key || '').startsWith(params[1])) };
    }
    if (sql.startsWith('INSERT INTO public.ventas')) return insertVenta(tx, params);
    if (sql.includes('SET idempotency_key = NULL')) return setKeyNull(tx, params[0]);
    if (sql.includes('SELECT payment_status FROM public.ventas')) {
      return { rows: state.ventas.filter((v) => params[0].includes(v.id)) };
    }
    if (sql.includes('SELECT * FROM public.ventas WHERE id = ANY')) {
      return { rows: state.ventas.filter((v) => params[0].includes(v.id)) };
    }
    if (sql.includes('UPDATE public.ventas SET payment_status = $2')) { setStatus(tx, params[0], params[1]); return undefined; }
    if (sql.includes('SET stock = stock + $2')) {
      state.product.stock += params[1];
      tx.undo.push(() => { state.product.stock -= params[1]; });
      return { rows: [{ stock: state.product.stock, variants: state.product.variants }] };
    }
    return undefined;
  };

  const newConnection = () => {
    const tx = { undo: [], releases: [], holdsProduct: false };
    const query = async (sql, params = []) => {
      const text = typeof sql === 'string' ? sql : sql.text;
      state.queries.push({ sql: text, params });
      return (await handle(tx, text, params)) || { rows: [], rowCount: 0 };
    };
    return { query, release: () => finish(tx, false) };
  };

  const standalone = newConnection();
  const pool = {
    query: standalone.query,
    connect: async () => newConnection(),
    on: () => undefined,
    options: { max: 20 },
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
  };
  return { state, pool };
};

module.exports = { createFakeCheckoutDb, UNIQUE_VIOLATION };
