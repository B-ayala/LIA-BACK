// Carga de lecturas públicas (catálogo, detalle) + readiness.
//   k6 run -e BASE_URL=https://staging.example -e PROFILE=smoke qa/k6/catalog.js
// Perfiles en qa/k6/lib.js. Durante la corrida, leer p95/p99 por ruta y el estado de
// cada carril en GET /health (header x-health-token). Con ACCESS_LOG_ALL=true el
// backend loguea un renglón por request (solo para una prueba puntual).

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { BASE_URL, THRESHOLDS, assertNotProduction, stagesFor } from './lib.js';

const shed503 = new Rate('shed_503');
const serverErrors = new Rate('server_errors');

export const options = {
  scenarios: { reads: { executor: 'ramping-vus', startVUs: 0, stages: stagesFor(__ENV.PROFILE || 'smoke') } },
  thresholds: THRESHOLDS,
};

export function setup() {
  assertNotProduction();
  const list = http.get(`${BASE_URL}/api/products?limit=24`);
  const products = list.status === 200 ? list.json('data') : [];
  return { productIds: products.map((product) => product.id) };
}

const track = (response) => {
  shed503.add(response.status === 503);
  serverErrors.add(response.status >= 500 && response.status !== 503);
};

export default function (data) {
  const roll = Math.random();
  if (roll < 0.6) {
    const offset = Math.floor(Math.random() * 3) * 24;
    const response = http.get(`${BASE_URL}/api/products?limit=24&offset=${offset}`, { tags: { kind: 'catalog' } });
    check(response, { 'catálogo 200 o 503 controlado': (r) => r.status === 200 || r.status === 503 }, { kind: 'catalog' });
    track(response);
  } else if (roll < 0.9 && data.productIds.length > 0) {
    const id = data.productIds[Math.floor(Math.random() * data.productIds.length)];
    const response = http.get(`${BASE_URL}/api/products/${id}`, { tags: { kind: 'detail' } });
    check(response, { 'detalle 200 o 503 controlado': (r) => r.status === 200 || r.status === 503 }, { kind: 'detail' });
    track(response);
  } else {
    const response = http.get(`${BASE_URL}/ready`, { tags: { kind: 'ready' } });
    check(response, { 'ready 200': (r) => r.status === 200 }, { kind: 'ready' });
  }
  sleep(Math.random() * 2 + 0.5);
}
