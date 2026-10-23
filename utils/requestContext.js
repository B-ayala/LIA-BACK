// Contexto por request (AsyncLocalStorage): permite que el logger agregue el
// `requestId` a cada línea sin pasar `req` por todas las capas. Con eso un 500 se
// correlaciona con todo lo que logueó esa request (services, modelos, MP).

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const runWithRequestId = (requestId, callback) => storage.run({ requestId }, callback);

const currentRequestId = () => storage.getStore()?.requestId;

module.exports = { runWithRequestId, currentRequestId };
