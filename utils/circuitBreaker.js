// Circuit breaker mínimo para dependencias externas.
//
// Sin él, con Mercado Pago caído cada checkout reserva stock, espera 8 s a MP,
// falla y compensa: se repite por cada intento y por cada request que reintenta,
// amplificando la carga justo cuando la dependencia está mal.
//
// Estados:
//  - cerrado: todo pasa; los fallos consecutivos se cuentan.
//  - abierto: tras `failureThreshold` fallos seguidos, rechaza al instante
//    (`CIRCUIT_OPEN`) durante `openMs`.
//  - semiabierto: vencido `openMs`, deja pasar UNA request de prueba; si sale
//    bien se cierra, si falla vuelve a abrirse.
//
// Estado en memoria del proceso, igual que el resto de los stores de resiliencia.

const logger = require('./logger');

const CIRCUIT_OPEN_CODE = 'CIRCUIT_OPEN';

const createCircuitBreaker = ({ name, failureThreshold, openMs, isFailure, now = Date.now }) => {
  let consecutiveFailures = 0;
  let openedAt = null;
  let probeInFlight = false;

  const isOpen = () => openedAt !== null;
  const cooldownElapsed = () => isOpen() && now() - openedAt >= openMs;

  const open = () => {
    if (!isOpen()) logger.warn('circuit_opened', { name, consecutiveFailures, openMs });
    openedAt = now();
  };

  const close = () => {
    if (isOpen()) logger.info('circuit_closed', { name });
    consecutiveFailures = 0;
    openedAt = null;
  };

  /** ¿Conviene intentar? No consume la request de prueba: sirve para decidir antes de reservar recursos. */
  const isAvailable = () => !isOpen() || (cooldownElapsed() && !probeInFlight);

  const retryAfterSeconds = () => (isOpen() ? Math.max(1, Math.ceil((openMs - (now() - openedAt)) / 1000)) : 0);

  const rejectFast = () => {
    const error = new Error(`Circuito abierto: ${name} no responde`);
    error.code = CIRCUIT_OPEN_CODE;
    error.retryAfterSeconds = retryAfterSeconds();
    return error;
  };

  const execute = async (operation) => {
    const isProbe = isOpen();
    if (isProbe && !isAvailable()) throw rejectFast();
    if (isProbe) probeInFlight = true;

    try {
      const result = await operation();
      close();
      return result;
    } catch (error) {
      if (isFailure(error)) {
        consecutiveFailures += 1;
        if (isProbe || consecutiveFailures >= failureThreshold) open();
      } else {
        // Un rechazo "normal" (4xx) prueba que la dependencia responde.
        close();
      }
      throw error;
    } finally {
      if (isProbe) probeInFlight = false;
    }
  };

  const state = () => {
    if (!isOpen()) return 'closed';
    return cooldownElapsed() ? 'half-open' : 'open';
  };

  return { execute, isAvailable, retryAfterSeconds, state };
};

module.exports = { createCircuitBreaker, CIRCUIT_OPEN_CODE };
