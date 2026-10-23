// Latencias por ruta en memoria: ventana de las últimas N requests de cada
// `METHOD /ruta/:param`, con p50/p95/p99 calculados al leer. Evita loguear cada
// request (volumen y costo de logs) y da los percentiles que hacen falta para
// las pruebas de carga y para decidir los umbrales de alerta.
//
// Estado en memoria del proceso: se pierde al reiniciar, igual que el resto de
// las métricas de /health. Tope de rutas distintas para que un scanner que pegue
// a URLs inexistentes no infle el Map (todo lo no ruteado cae en `unmatched`).

const WINDOW_SIZE = 500;
const MAX_ROUTES = 150;
const UNMATCHED = 'unmatched';
const PERCENTILES = { p50: 0.5, p95: 0.95, p99: 0.99 };

const routes = new Map(); // key -> { samples, next, count, errors5xx, byClass }
const processEvents = { unhandledRejection: 0, uncaughtException: 0 };

const newRecord = () => ({ samples: [], next: 0, count: 0, errors5xx: 0, byClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } });

const recordFor = (key) => {
  const existing = routes.get(key);
  if (existing) return existing;
  // `unmatched` siempre puede crearse (por eso el tope real es MAX_ROUTES + 1): sin esa excepción se recursaría sin fin.
  if (routes.size >= MAX_ROUTES && key !== UNMATCHED) return recordFor(UNMATCHED);
  const created = newRecord();
  routes.set(key, created);
  return created;
};

const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

const recordRequest = (routeKey, statusCode, durationMs) => {
  const record = recordFor(routeKey || UNMATCHED);
  if (record.samples.length < WINDOW_SIZE) record.samples.push(durationMs);
  else record.samples[record.next] = durationMs;
  record.next = (record.next + 1) % WINDOW_SIZE;
  record.count += 1;
  record.byClass[`${Math.floor(statusCode / 100)}xx`] += 1;
  if (statusCode >= 500) record.errors5xx += 1;
};

const recordProcessEvent = (name) => {
  if (name in processEvents) processEvents[name] += 1;
};

const round = (value) => Math.round(value * 10) / 10;

const routeSnapshot = (record) => {
  const sorted = [...record.samples].sort((a, b) => a - b);
  const latencyMs = Object.fromEntries(
    Object.entries(PERCENTILES).map(([name, fraction]) => [name, round(percentile(sorted, fraction))])
  );
  return { count: record.count, errors5xx: record.errors5xx, ...record.byClass, latencyMs };
};

/** Rutas con más tráfico primero; el detalle completo vive solo en /health autenticado. */
const metricsSnapshot = () => ({
  windowSize: WINDOW_SIZE,
  process: { ...processEvents },
  routes: Object.fromEntries(
    [...routes.entries()].sort((a, b) => b[1].count - a[1].count).map(([key, record]) => [key, routeSnapshot(record)])
  ),
});

const resetMetrics = () => {
  routes.clear();
  processEvents.unhandledRejection = 0;
  processEvents.uncaughtException = 0;
};

module.exports = { recordRequest, recordProcessEvent, metricsSnapshot, resetMetrics, UNMATCHED };
