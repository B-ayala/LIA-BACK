/**
 * Ejecuta `worker` sobre `items` con a lo sumo `limit` llamadas en paralelo y
 * devuelve los resultados en el mismo orden que `items`.
 *
 * El worker NO debe rechazar: si lo hace, `Promise.all` corta el lote entero.
 * Los callers (sweep, conciliación) atrapan sus errores por ítem.
 */
const mapWithConcurrency = async (items, limit, worker) => {
  const results = new Array(items.length);
  let next = 0;
  const runLane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, runLane));
  return results;
};

module.exports = { mapWithConcurrency };
