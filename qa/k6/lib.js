// Utilidades compartidas de las pruebas de carga (k6). NO correr contra producción.
import { fail } from 'k6';

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const PRODUCTION_HOSTS = ['liaa.com.ar'];

/** Aborta si el destino parece producción, salvo autorización explícita (ALLOW_PROD=true). */
export function assertNotProduction() {
  const looksLikeProduction = PRODUCTION_HOSTS.some((host) => BASE_URL.includes(host));
  if (looksLikeProduction && __ENV.ALLOW_PROD !== 'true') {
    fail(`BASE_URL (${BASE_URL}) parece producción. Usá staging; ALLOW_PROD=true solo con autorización explícita.`);
  }
}

/**
 * Perfiles de carga. Elegir con `-e PROFILE=<nombre>`:
 *  smoke  -> valida el script (5 VUs, 1 min)
 *  load   -> escalones 100 / 500 / 1000 VUs (12 min sostenidos por escalón)
 *  stress -> sube hasta encontrar el punto de quiebre
 *  spike  -> salto brusco 50 -> 800 VUs en 10 s
 *  soak   -> endurance: carga moderada sostenida (SOAK_DURATION, default 4h)
 */
export function stagesFor(profile) {
  const profiles = {
    smoke: [{ duration: '1m', target: 5 }],
    load: [
      { duration: '2m', target: 100 }, { duration: '12m', target: 100 },
      { duration: '2m', target: 500 }, { duration: '12m', target: 500 },
      { duration: '2m', target: 1000 }, { duration: '12m', target: 1000 },
      { duration: '3m', target: 0 },
    ],
    stress: [
      { duration: '3m', target: 200 }, { duration: '3m', target: 500 },
      { duration: '3m', target: 1000 }, { duration: '3m', target: 1500 },
      { duration: '3m', target: 2000 }, { duration: '3m', target: 0 },
    ],
    spike: [
      { duration: '2m', target: 50 }, { duration: '10s', target: 800 },
      { duration: '3m', target: 800 }, { duration: '10s', target: 50 }, { duration: '3m', target: 50 },
    ],
    soak: [
      { duration: '5m', target: 150 }, { duration: __ENV.SOAK_DURATION || '4h', target: 150 }, { duration: '5m', target: 0 },
    ],
  };
  return profiles[profile] || fail(`PROFILE desconocido: ${profile}. Opciones: ${Object.keys(profiles).join(', ')}`);
}

/**
 * Umbrales = métricas objetivo del informe (propuestas, a ajustar con la primera línea base).
 * 503 SERVER_BUSY es degradación controlada: se mide aparte y no cuenta como error de servidor.
 */
export const THRESHOLDS = {
  'http_req_duration{kind:catalog}': ['p(95)<300', 'p(99)<800'],
  'http_req_duration{kind:detail}': ['p(95)<300', 'p(99)<800'],
  'checks{kind:catalog}': ['rate>0.99'],
  shed_503: ['rate<0.01'],
  server_errors: ['rate<0.001'],
};
