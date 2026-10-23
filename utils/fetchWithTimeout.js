// Sin tope de espera, una dependencia lenta (Supabase Auth) deja la request
// colgada y retiene un slot del bulkhead: unas decenas bastan para que toda la
// API responda 503. `server.requestTimeout` no ayuda: solo cubre la recepción.
const DEFAULT_TIMEOUT_MS = 5000;

const fetchWithTimeout = (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });

/** `AbortSignal.timeout` rechaza con TimeoutError; un corte de red no cuenta como timeout. */
const isTimeoutError = (error) => error?.name === 'TimeoutError';

module.exports = { fetchWithTimeout, isTimeoutError, DEFAULT_TIMEOUT_MS };
