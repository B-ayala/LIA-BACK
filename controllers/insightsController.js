const Insights = require('../models/Insights');
const { caches, TTL } = require('../utils/cache');
const logger = require('../utils/logger');

/**
 * Endpoints de analítica del asistente del panel admin.
 *
 * Contrato de respuesta (uniforme para que el frontend renderice cualquier
 * insight con un único componente):
 *   {
 *     success: true,
 *     insight: {
 *       id, title, generatedAt, severity,         // 'critical' | 'warning' | 'info' | 'ok'
 *       metrics: [{ label, value, format, tone? }],
 *       table: { columns: [{ key, label, format, align? }], rows: [...], rowAction? } | null,
 *       actions: [{ type, label, to? }],
 *       emptyText
 *     }
 *   }
 *
 * `format` es un hint de presentación que resuelve el frontend (currency, number,
 * date, age, text). El backend NO formatea moneda/fechas: evita acoplar el locale.
 */

const LOW_STOCK_DEFAULT_THRESHOLD = 5;
const TABLE_ROW_LIMIT = 50;
const TOP_PRODUCTS_LIMIT = 10;

const sum = (rows, key) => rows.reduce((acc, r) => acc + Number(r[key] || 0), 0);
const maxOf = (rows, key) => rows.reduce((acc, r) => Math.max(acc, Number(r[key] || 0)), 0);
const barPct = (value, max) => (max > 0 ? Math.round((Number(value) / max) * 100) : 0);

/** Entero saneado dentro de [min, max]; cae al default si no es válido. */
const parseBoundedInt = (raw, fallback, min, max) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
};

/**
 * Ejecuta una consulta de analítica con caché de corta duración y single-flight.
 *
 * Son agregaciones sobre `ventas` (GROUP BY, window functions) mucho más caras
 * que un SELECT por id, y el asistente del panel las dispara de a varias por
 * pantalla. Con caché por consulta, abrir el panel varias veces —o dos admins a
 * la vez— no multiplica el costo en la base.
 *
 * `generatedAt` viaja DENTRO del valor cacheado: el frontend muestra el momento
 * real del dato, no el de la respuesta HTTP.
 *
 * @returns {Promise<{data: any, generatedAt: string}>}
 */
const cachedQuery = (key, loader) =>
  caches.insights.getOrSet(key, TTL.insights, async () => ({
    data: await loader(),
    generatedAt: new Date().toISOString(),
  }));

const ok = (res, insight, generatedAt) =>
  res.status(200).json({
    success: true,
    insight: { ...insight, generatedAt },
  });

const fail = (res, action) => (error) => {
  logger.error('insights_query_failed', { action, code: error.code, error: error.message });
  return res
    .status(500)
    .json({ success: false, code: 'INSIGHT_FAILED', message: 'No se pudo generar la consulta. Reintentá en unos segundos.' });
};

const getLowStock = async (req, res) => {
  try {
    const threshold = parseBoundedInt(req.query.threshold, LOW_STOCK_DEFAULT_THRESHOLD, 1, 100);
    const { data: rows, generatedAt } = await cachedQuery(`low-stock:${threshold}`, () =>
      Insights.lowStock(threshold, TABLE_ROW_LIMIT)
    );
    const outOfStock = rows.filter((r) => r.stock <= 0).length;

    return ok(res, {
      id: 'low-stock',
      title: `Productos con stock menor a ${threshold}`,
      severity: outOfStock > 0 ? 'critical' : rows.length > 0 ? 'warning' : 'ok',
      metrics: [
        { label: 'Productos afectados', value: rows.length, format: 'number' },
        { label: 'Sin stock', value: outOfStock, format: 'number', tone: outOfStock > 0 ? 'critical' : 'ok' },
        { label: 'Umbral', value: `< ${threshold}`, format: 'text' },
      ],
      table: {
        columns: [
          { key: 'name', label: 'Producto', format: 'text' },
          { key: 'category', label: 'Categoría', format: 'text' },
          { key: 'stock', label: 'Stock', format: 'stock', align: 'center' },
          { key: 'price', label: 'Precio', format: 'currency', align: 'right' },
        ],
        rows,
      },
      actions: [{ type: 'navigate', label: 'Generar reposición', to: '/admin/products' }],
      emptyText: 'Ningún producto por debajo del umbral. Stock saludable. 🎉',
    }, generatedAt);
  } catch (error) {
    return fail(res, 'low-stock')(error);
  }
};

const getSalesToday = async (_req, res) => {
  try {
    const { data: { summary, items }, generatedAt } = await cachedQuery('sales-today', () =>
      Insights.salesToday(TABLE_ROW_LIMIT)
    );

    return ok(res, {
      id: 'sales-today',
      title: 'Ventas de hoy',
      severity: 'info',
      metrics: [
        { label: 'Facturado', value: summary.revenue, format: 'currency', tone: 'ok' },
        { label: 'Pedidos', value: summary.orders, format: 'number' },
        { label: 'Unidades', value: summary.units, format: 'number' },
      ],
      table: {
        columns: [
          { key: 'product_name', label: 'Producto', format: 'text' },
          { key: 'buyer_name', label: 'Cliente', format: 'text' },
          { key: 'quantity', label: 'Cant.', format: 'number', align: 'center' },
          { key: 'total_price', label: 'Total', format: 'currency', align: 'right' },
          { key: 'created_at', label: 'Hora', format: 'time', align: 'right' },
        ],
        rows: items,
      },
      actions: [{ type: 'navigate', label: 'Ver todas las ventas', to: '/admin/sales' }],
      emptyText: 'Todavía no hay ventas pagadas hoy. El día recién empieza. ☕',
    }, generatedAt);
  } catch (error) {
    return fail(res, 'sales-today')(error);
  }
};

const getPendingPayment = async (_req, res) => {
  try {
    const { data: rows, generatedAt } = await cachedQuery('pending-payment', () =>
      Insights.pendingPayment(TABLE_ROW_LIMIT)
    );
    const potential = rows.reduce((sum, r) => sum + Number(r.total_price || 0), 0);
    const byMp = rows.filter((r) => r.payment_method === 'mp').length;

    return ok(res, {
      id: 'pending-payment',
      title: 'Pedidos pendientes de pago',
      severity: rows.length > 0 ? 'warning' : 'ok',
      metrics: [
        { label: 'Pendientes', value: rows.length, format: 'number', tone: rows.length > 0 ? 'warning' : 'ok' },
        { label: 'Monto en juego', value: potential, format: 'currency' },
        { label: 'Mercado Pago / Transfer.', value: `${byMp} / ${rows.length - byMp}`, format: 'text' },
      ],
      table: {
        columns: [
          { key: 'product_name', label: 'Producto', format: 'text' },
          { key: 'buyer_name', label: 'Cliente', format: 'text' },
          { key: 'payment_method', label: 'Método', format: 'method', align: 'center' },
          { key: 'origin', label: 'WhatsApp', format: 'origin', align: 'center' },
          { key: 'total_price', label: 'Total', format: 'currency', align: 'right' },
          { key: 'age_seconds', label: 'Espera', format: 'age', align: 'right' },
        ],
        rows,
      },
      actions: [{ type: 'navigate', label: 'Gestionar en Ventas', to: '/admin/sales' }],
      emptyText: 'No hay pedidos esperando pago. Todo al día. ✅',
    }, generatedAt);
  } catch (error) {
    return fail(res, 'pending-payment')(error);
  }
};

const getPendingPickups = async (_req, res) => {
  try {
    const { data: rows, generatedAt } = await cachedQuery('pending-pickups', () =>
      Insights.pendingPickups(TABLE_ROW_LIMIT)
    );
    const amount = sum(rows, 'total_price');
    const oldest = maxOf(rows, 'age_seconds');

    return ok(res, {
      id: 'pending-pickups',
      title: 'Retiros en local por WhatsApp sin confirmar',
      severity: rows.length > 0 ? 'warning' : 'ok',
      metrics: [
        { label: 'Para contactar', value: rows.length, format: 'number', tone: rows.length > 0 ? 'warning' : 'ok' },
        { label: 'Monto', value: amount, format: 'currency' },
        { label: 'Más antiguo', value: oldest, format: 'age' },
      ],
      table: {
        columns: [
          { key: 'product_name', label: 'Producto', format: 'text' },
          { key: 'buyer_name', label: 'Cliente', format: 'text' },
          { key: 'origin', label: 'WhatsApp', format: 'origin', align: 'center' },
          { key: 'total_price', label: 'Total', format: 'currency', align: 'right' },
          { key: 'age_seconds', label: 'Hace', format: 'age', align: 'right' },
        ],
        rows,
        rowAction: { kind: 'contact-email', label: 'Contactar', emailKey: 'buyer_email', subjectField: 'product_name' },
      },
      actions: [{ type: 'navigate', label: 'Ver en Ventas', to: '/admin/sales' }],
      emptyText: 'No hay retiros por WhatsApp pendientes de confirmar. 👌',
    }, generatedAt);
  } catch (error) {
    return fail(res, 'pending-pickups')(error);
  }
};

const getTopProducts = async (_req, res) => {
  try {
    const { data: rows, generatedAt } = await cachedQuery('top-products', () =>
      Insights.topProducts(TOP_PRODUCTS_LIMIT)
    );
    const maxQty = rows.reduce((max, r) => Math.max(max, Number(r.qty || 0)), 0) || 1;
    const totalUnits = rows.reduce((sum, r) => sum + Number(r.qty || 0), 0);
    const totalRevenue = rows.reduce((sum, r) => sum + Number(r.revenue || 0), 0);

    const tableRows = rows.map((r, index) => ({
      rank: index + 1,
      product_name: r.product_name,
      qty: r.qty,
      revenue: r.revenue,
      delta: r.qty - r.prev_qty,
      barPct: Math.round((Number(r.qty) / maxQty) * 100),
    }));

    return ok(res, {
      id: 'top-products',
      title: 'Productos más vendidos del mes',
      severity: 'info',
      metrics: [
        { label: 'Top del mes', value: rows[0] ? rows[0].product_name : '—', format: 'text', tone: 'ok' },
        { label: 'Unidades (top 10)', value: totalUnits, format: 'number' },
        { label: 'Facturación (top 10)', value: totalRevenue, format: 'currency' },
      ],
      table: {
        columns: [
          { key: 'rank', label: '#', format: 'number', align: 'center' },
          { key: 'product_name', label: 'Producto', format: 'bar' },
          { key: 'qty', label: 'Vendidas', format: 'number', align: 'center' },
          { key: 'delta', label: 'vs. mes ant.', format: 'delta', align: 'center' },
          { key: 'revenue', label: 'Facturación', format: 'currency', align: 'right' },
        ],
        rows: tableRows,
      },
      actions: [{ type: 'navigate', label: 'Ver productos', to: '/admin/products' }],
      emptyText: 'Aún no hay ventas pagadas este mes para rankear.',
    }, generatedAt);
  } catch (error) {
    return fail(res, 'top-products')(error);
  }
};

const getSalesGrowth = async (_req, res) => {
  try {
    const { data: rows, generatedAt } = await cachedQuery('sales-growth', () =>
      Insights.salesGrowth(TOP_PRODUCTS_LIMIT)
    );
    const maxGrowth = maxOf(rows, 'growth') || 1;
    const tableRows = rows.map((r, index) => ({
      rank: index + 1,
      product_name: r.product_name,
      qty: r.qty,
      growth: r.growth,
      barPct: barPct(r.growth, maxGrowth),
    }));

    return ok(res, {
      id: 'sales-growth',
      title: 'Productos con mayor crecimiento',
      severity: 'info',
      metrics: [
        { label: 'Lidera', value: rows[0] ? rows[0].product_name : '—', format: 'text', tone: 'ok' },
        { label: 'En crecimiento', value: rows.length, format: 'number' },
        { label: 'Unidades sumadas', value: sum(rows, 'growth'), format: 'number' },
      ],
      table: {
        columns: [
          { key: 'rank', label: '#', format: 'number', align: 'center' },
          { key: 'product_name', label: 'Producto', format: 'bar' },
          { key: 'qty', label: 'Mes', format: 'number', align: 'center' },
          { key: 'growth', label: 'vs. mes ant.', format: 'delta', align: 'center' },
        ],
        rows: tableRows,
      },
      actions: [{ type: 'navigate', label: 'Ver productos', to: '/admin/products' }],
      emptyText: 'Ningún producto creció respecto al mes anterior todavía.',
    }, generatedAt);
  } catch (error) {
    return fail(res, 'sales-growth')(error);
  }
};

const getPickupsToConfirm = async (_req, res) => {
  try {
    const { data: rows, generatedAt } = await cachedQuery('pickups-to-confirm', () =>
      Insights.pickupsToConfirm(TABLE_ROW_LIMIT)
    );

    return ok(res, {
      id: 'pickups-to-confirm',
      title: 'Retiros en local por confirmar',
      severity: rows.length > 0 ? 'warning' : 'ok',
      metrics: [
        { label: 'Por entregar', value: rows.length, format: 'number', tone: rows.length > 0 ? 'warning' : 'ok' },
        { label: 'Monto', value: sum(rows, 'total_price'), format: 'currency' },
        { label: 'Más antiguo', value: maxOf(rows, 'age_seconds'), format: 'age' },
      ],
      table: {
        columns: [
          { key: 'product_name', label: 'Producto', format: 'text' },
          { key: 'buyer_name', label: 'Cliente', format: 'text' },
          { key: 'total_price', label: 'Total', format: 'currency', align: 'right' },
          { key: 'age_seconds', label: 'Hace', format: 'age', align: 'right' },
        ],
        rows,
        rowAction: { kind: 'contact-email', label: 'Contactar', emailKey: 'buyer_email', subjectField: 'product_name' },
      },
      actions: [{ type: 'navigate', label: 'Ir a Despachos', to: '/admin/dispatches' }],
      emptyText: 'No hay retiros pagados esperando confirmación. 👌',
    }, generatedAt);
  } catch (error) {
    return fail(res, 'pickups-to-confirm')(error);
  }
};

module.exports = {
  getLowStock,
  getSalesToday,
  getPendingPayment,
  getPendingPickups,
  getTopProducts,
  getSalesGrowth,
  getPickupsToConfirm,
};
