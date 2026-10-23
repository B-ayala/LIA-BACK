/**
 * Logger estructurado (JSON en una línea) para que Railway/Datadog puedan
 * indexar los campos en vez de parsear texto libre.
 *
 * En desarrollo se imprime legible; en producción, JSON puro.
 */

const { currentRequestId } = require('./requestContext');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const currentLevel = () => LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

const isProduction = () => process.env.NODE_ENV === 'production';

const write = (level, message, context) => {
  if (LEVELS[level] < currentLevel()) return;

  const requestId = currentRequestId();
  const entry = { level, time: new Date().toISOString(), message, ...(requestId ? { requestId } : {}), ...context };
  const line = isProduction()
    ? JSON.stringify(entry)
    : `[${level}] ${message}${requestId ? ` (${requestId})` : ''}${context && Object.keys(context).length ? ` ${JSON.stringify(context)}` : ''}`;

  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

module.exports = {
  debug: (message, context = {}) => write('debug', message, context),
  info: (message, context = {}) => write('info', message, context),
  warn: (message, context = {}) => write('warn', message, context),
  error: (message, context = {}) => write('error', message, context),
};
