Pruebas de carga (k6). Solo contra staging, con la base y Mercado Pago en modo sandbox.
NO se ejecutaron todavia: no hay entorno de staging ni k6 instalado. Orden sugerido:

  1. smoke  : k6 run -e BASE_URL=... -e PROFILE=smoke  qa/k6/catalog.js
  2. load   : k6 run -e BASE_URL=... -e PROFILE=load   qa/k6/catalog.js   (100 -> 500 -> 1000 VUs)
  3. stress : k6 run -e BASE_URL=... -e PROFILE=stress qa/k6/catalog.js
  4. spike  : k6 run -e BASE_URL=... -e PROFILE=spike  qa/k6/catalog.js
  5. stock  : k6 run ... qa/k6/last-unit.js   (precondiciones en el archivo)
  6. soak   : k6 run -e PROFILE=soak -e SOAK_DURATION=4h qa/k6/catalog.js

Los scripts abortan si BASE_URL parece produccion (salvo ALLOW_PROD=true).

Durante la corrida mirar GET /health con el header x-health-token (HEALTH_DETAIL_TOKEN):
  - requests.routes[...].latencyMs -> p50/p95/p99 por ruta
  - concurrency.<carril>           -> activas, en cola y rechazadas por carril
  - db.waiting                     -> debe ser ~0 sostenido
  - mercadopago.circuit            -> closed

Los umbrales de lib.js son las metricas objetivo PROPUESTAS en el informe de auditoria:
ajustarlas con la primera linea base. Quedan sin cubrir (no hay script): webhook de MP
(exige firma valida) y checkout con Mercado Pago (exige completar el pago en el sandbox).
