/**
 * Rotación de consultas a Mercado Pago por referencia de compra.
 *
 * El sweep solo puede hacer unas pocas consultas por ciclo. Sin rotación, las
 * compras retenidas (pago en curso) ocuparían siempre los primeros lugares y
 * las demás nunca se consultarían. Se recuerda en memoria cuándo se consultó
 * cada referencia: primero van las nunca consultadas, después las más viejas.
 * Es memoria de proceso a propósito: si se pierde (reinicio) lo peor que pasa
 * es una consulta de más.
 */

const NEVER_CHECKED = 0;
const DEFAULT_MAX_ENTRIES = 5000;

const createLookupRotation = ({ minIntervalMs = 0, maxEntries = DEFAULT_MAX_ENTRIES } = {}) => {
  const lastCheckedAt = new Map();

  const checkedAt = (reference) => lastCheckedAt.get(reference) ?? NEVER_CHECKED;

  /** Hasta `limit` referencias para consultar ahora, la menos reciente primero (orden estable). */
  const pick = (references, limit, now = Date.now()) =>
    references
      .filter((reference) => now - checkedAt(reference) >= minIntervalMs)
      .sort((a, b) => checkedAt(a) - checkedAt(b))
      .slice(0, limit);

  /** Referencias consultadas hace menos de `minIntervalMs`: todavía no les toca una nueva consulta. */
  const recentlyChecked = (now = Date.now()) =>
    [...lastCheckedAt].filter(([, at]) => now - at < minIntervalMs).map(([reference]) => reference);

  const markChecked = (reference, now = Date.now()) => {
    lastCheckedAt.delete(reference);
    lastCheckedAt.set(reference, now);
    if (lastCheckedAt.size > maxEntries) {
      lastCheckedAt.delete(lastCheckedAt.keys().next().value);
    }
  };

  const forget = (reference) => lastCheckedAt.delete(reference);

  const pruneOlderThan = (maxAgeMs, now = Date.now()) => {
    for (const [reference, at] of lastCheckedAt) {
      if (now - at > maxAgeMs) lastCheckedAt.delete(reference);
    }
  };

  return { pick, recentlyChecked, markChecked, forget, pruneOlderThan, size: () => lastCheckedAt.size };
};

module.exports = { createLookupRotation };
