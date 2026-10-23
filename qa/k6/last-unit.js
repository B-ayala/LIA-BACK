// Concurrencia de stock: N compradores a la vez sobre un producto con EXACTAMENTE 1 unidad.
// Esperado: una sola reserva 201 y el resto 409; nunca dos 201 (sobreventa).
//
// Pre-condiciones (staging, MP sandbox):
//  - Un producto activo SIN talles con stock = 1 (PRODUCT_ID y su precio PRICE). Los productos con
//    talles exigen `unitsConfig` por unidad y este script no lo arma.
//  - TOKENS: access tokens de VARIOS usuarios de prueba separados por coma. Cada cuenta
//    tiene su propio rate limit y tope de pendientes: con una sola cuenta se mide el límite, no el stock.
//  k6 run -e BASE_URL=https://staging.example -e PRODUCT_ID=14 -e PRICE=10000 -e TOKENS=t1,t2,t3 qa/k6/last-unit.js
//
// Después: cancelar la reserva ganadora desde el admin y restaurar el stock; verificar en la
// base que stock + reservas pendientes = 1 (ni sobreventa ni stock fantasma).

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';
import { BASE_URL, assertNotProduction } from './lib.js';

const created = new Counter('reservations_created');
const outOfStock = new Counter('reservations_out_of_stock');
const TOKENS = (__ENV.TOKENS || '').split(',').filter(Boolean);
const COMPETITORS = Math.max(TOKENS.length, 1);

export const options = {
  scenarios: { race: { executor: 'shared-iterations', vus: COMPETITORS, iterations: COMPETITORS, maxDuration: '2m' } },
  thresholds: { reservations_created: ['count<=1'] },
};

export function setup() {
  assertNotProduction();
  if (TOKENS.length < 2 || !__ENV.PRODUCT_ID || !__ENV.PRICE) throw new Error('Faltan TOKENS (al menos 2), PRODUCT_ID o PRICE');
}

export default function () {
  const price = Number(__ENV.PRICE);
  const token = TOKENS[(__VU - 1) % TOKENS.length];
  const body = {
    buyerName: `Carga ${__VU}`,
    buyerEmail: `carga${__VU}@example.test`,
    items: [{
      productId: Number(__ENV.PRODUCT_ID),
      productName: 'Producto de prueba de carga',
      quantity: 1,
      unitPrice: price,
      totalPrice: price,
    }],
    shippingMethod: 'local',
    shippingCost: 0,
    totalPrice: price,
  };
  const response = http.post(`${BASE_URL}/api/orders/transfer`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': uuidv4() },
  });
  if (response.status === 201) created.add(1);
  if (response.status === 409) outOfStock.add(1);
  check(response, { '201 (ganó) o 409 (perdió), nunca 5xx': (r) => r.status === 201 || r.status === 409 });
}
