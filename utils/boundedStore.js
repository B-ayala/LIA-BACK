// Map en memoria con tope duro de entradas y purga periódica de las vencidas.
// Los stores de seguridad (fuerza bruta, límites por email) se llenan con datos
// que controla el cliente: sin tope, emails únicos inflan la memoria del proceso
// hasta tumbarlo, y al reiniciar se pierden todos los límites.
//
// Al superar el tope se descartan las entradas más viejas (el Map conserva el
// orden de inserción).

const createBoundedStore = ({ maxEntries, isExpired, purgeIntervalMs }) => {
  const store = new Map();

  const purgeExpired = () => {
    for (const [key, record] of store) {
      if (isExpired(record)) store.delete(key);
    }
  };

  const enforceCapacity = () => {
    for (const key of store.keys()) {
      if (store.size <= maxEntries) return;
      store.delete(key);
    }
  };

  // unref: el timer de limpieza no debe impedir que el proceso termine.
  setInterval(purgeExpired, purgeIntervalMs).unref();

  return {
    get: (key) => store.get(key),
    set: (key, record) => {
      store.set(key, record);
      enforceCapacity();
    },
    delete: (key) => store.delete(key),
    purgeExpired,
    size: () => store.size,
  };
};

module.exports = { createBoundedStore };
