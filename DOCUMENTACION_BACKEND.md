# Documentación Técnica — Backend (lia-store / "lia-ecommerce")

> Documentación de **cómo está construido hoy** el backend, leída directamente del código fuente
> (`server.js`, `routes/`, `controllers/`, `models/`, `middleware/`, `config/`). Pensada como
> referencia de consulta antes de cualquier cambio.

---

## 1. Resumen

API REST en **Node.js + Express** con patrón **MVC**, sobre **PostgreSQL/Supabase** (acceso
directo vía `pg`, no vía el SDK de Supabase). Expone seis áreas bajo el prefijo `/api`:

- **`/api/users`** — perfiles de usuario (sobre `public.profiles` + `auth.users`), login contra
  Supabase Auth y tracker de rate-limit de signup.
- **`/api/products`** — CRUD de productos (lectura pública, escritura solo admin).
- **`/api/orders`** — checkout completo: preferencia de Mercado Pago, órdenes por transferencia,
  cancelación, confirmación de pago, webhook de MP y expiración de pendientes.
- **`/api/shipping`** — cotización de envío por código postal.
- **`/api/admin/insights`** — analítica del asistente del panel admin (solo admin).
- **`/api/cloudinary`** — firma de uploads y gestión de imágenes/carpetas vía Admin API de Cloudinary.

La autenticación se basa en el **access token de Supabase Auth** que emite el frontend: el
backend lo **verifica contra Supabase** (`GET /auth/v1/user`) y busca el rol en
`public.profiles`. Ver §6.

---

## 2. Tecnologías y dependencias

| Dependencia | Versión | Uso |
|---|---|---|
| `express` | ^4.18.2 | servidor HTTP / routing |
| `compression` | ^1.8.1 | gzip de las respuestas (el JSON del catálogo es muy repetitivo) |
| `pg` | ^8.11.3 | cliente PostgreSQL (pool) |
| `jsonwebtoken` | ^9.0.3 | declarado; la verificación del token la hace `authMiddleware` contra Supabase Auth (ver §6) |
| `bcryptjs` | ^2.4.3 | hashing de passwords (declarado; sin uso activo: las passwords las maneja Supabase Auth) |
| `cors` | ^2.8.5 | CORS con allowlist por `FRONTEND_URL` |
| `dotenv` | ^16.6.1 | variables de entorno |
| `nodemon` | ^3.0.1 (dev) | hot-reload en desarrollo |

- `package.json` → `name: lia-ecommerce`, `main: server.js`, `engines.node: >=14`.
- Scripts: `start` (`node server.js`), `dev` (`nodemon server.js`), `init-db` (`node config/initDatabase.js`).

---

## 3. Estructura de carpetas

```
lia-store/
├── server.js                  # Entry point: compresión, CORS, límites de body, rate limit global,
│                              # bulkhead, montaje de rutas, /health, error handler, apagado ordenado
├── package.json               # deps + scripts (start / dev / init-db)
├── .env.example               # plantilla de variables de entorno
├── .gitignore
│
├── config/
│   ├── database.js            # Pool de pg (SSL) parametrizable + timeouts, connectDB() con reintentos,
│   │                          # getPoolStats() para /health y closeDB() para el apagado
│   ├── cors.js                # allowlist por FRONTEND_URL (+ cualquier localhost en desarrollo)
│   ├── initDatabase.js        # `npm run init-db`: profiles, RLS, trigger handle_new_user, carousel_images…
│   └── migrateData.js         # script legacy de migración MongoDB → PostgreSQL (referencia, opcional)
│
├── db/migrations/             # SQL versionado (se corre en el SQL Editor de Supabase)
│   ├── 2026-06-16_add_origin_to_ventas.sql
│   ├── 2026-08-08_add_performance_indexes.sql   # índices de las consultas calientes
│   ├── 2026-10-13_payment_reconciliation_and_schema_hardening.sql  # mp_*, oversold, CHECKs
│   └── 2026-10-14_add_review_reason_to_ventas.sql                  # ventas.review_reason
│
├── routes/                    # Endpoints + su rate limit y política de caché HTTP
│   ├── userRoutes.js          # /api/users            (login con el límite más estricto)
│   ├── productRoutes.js       # /api/products         (lectura pública cacheable; escritura admin)
│   ├── orderRoutes.js         # /api/orders           (checkout, webhook, nudge; todo no-store)
│   ├── shippingRoutes.js      # /api/shipping         (tarifa plana, cacheable 5 min)
│   ├── insightsRoutes.js      # /api/admin/insights   (solo admin)
│   └── cloudinaryRoutes.js    # /api/cloudinary
│
├── controllers/               # Lógica de cada endpoint
│   ├── userController.js       # login, CRUD de perfiles, signup status/ratelimit, getUserByAuthId
│   ├── productController.js    # CRUD + catálogo paginado y cacheado; errores 500 genéricos
│   ├── orderController.js      # checkout (mp-preference / transfer), Mis compras, mp-confirm, webhook
│   ├── orderCancellationController.js # /:id/cancel, mp-cancel, nudge
│   ├── transferOrderController.js     # confirm / cancel / confirm-late de transferencias (admin)
│   ├── insightsController.js   # analítica del asistente admin (cacheada 60 s)
│   ├── shippingController.js   # cotización por código postal
│   └── cloudinaryController.js # firma SHA1, delete, getImages, getConfig, folders
│
├── models/                    # Acceso a datos (SQL parametrizado)
│   ├── User.js                # profiles
│   ├── Order.js               # ventas + stock (FOR UPDATE, reserva, cancelación, expiración)
│   ├── OrderPayment.js        # cobros MP: saldar, pago tardío, review_reason, conciliación
│   ├── Product.js             # productos: catálogo, update optimista, borrado sin pendientes
│   ├── IdempotencyKey.js      # respuestas idempotentes de checkout (idempotency_keys)
│   └── Insights.js            # agregaciones de analítica
│
├── middleware/
│   ├── authMiddleware.js       # verifica el token contra Supabase (con caché corta) + adminMiddleware
│   ├── rateLimit.js            # límites por endpoint (ventana deslizante) con headers estándar
│   ├── concurrencyLimit.js     # un bulkhead por carril (read/auth/admin/checkout/local/webhook) + presupuesto de conexiones compartido (`general`) + cola con timeout → 503
│   ├── requestObserver.js      # X-Request-Id, latencia por ruta (p50/p95/p99) y log de requests lentas/5xx
│   ├── proxyDiagnostic.js      # loguea al arrancar los saltos de X-Forwarded-For (verifica `trust proxy`)
│   ├── httpCache.js            # Cache-Control público / no-store
│   ├── securityHeaders.js      # CSP/HSTS/nosniff/X-Frame-Options en toda respuesta
│   ├── requestDeadline.js      # corta con 503 REQUEST_TIMEOUT una request que no responde en 25 s (no se monta en /api/orders)
│   ├── validateBody.js         # validación de body con Zod
│   ├── validateQuery.js        # query string con Zod → req.validatedQuery (400 VALIDATION_ERROR)
│   └── validateParams.js       # :id de orden (uuid) y de producto (dígitos) → 400 si no cumple
│
├── services/                  # Casos de uso (sin req/res) y tareas periódicas
│   ├── checkout.js            # mp-preference / transfer → { status, body }
│   ├── checkoutReservation.js # reserva transaccional (FOR UPDATE por productId) y compensación
│   ├── mpCancellation.js      # cancelar compras MP consultando a MP antes (released/held/paid)
│   ├── transferResolution.js  # confirmar / cancelar / confirmar tarde transferencias
│   ├── staleOrderSweep.js     # sweep de pendientes vencidas (rotación, concurrencia acotada)
│   ├── closedOrderReconciliation.js # cada 15 min: pagos aprobados de compras ya cerradas
│   └── orderMaintenance.js    # expireStaleOrders (sweep + purga idempotencia) y chequeo de migraciones
│
├── utils/
│   ├── cache.js               # caché TTL + single-flight (coalescing) e invalidación del catálogo
│   ├── checkoutRules.js       # reglas puras del checkout: precio, envío, orden de bloqueo, códigos de error
│   ├── unitsConfig.js         # validación/saneo de la selección de variantes por unidad
│   ├── variantStock.js        # stock por talle (stockByOption)
│   ├── mpPreference.js        # payload de la preferencia de MP (external_reference, medios excluidos)
│   ├── paymentReconciliation.js # clasificación de pagos de MP (aprobado / en curso / ninguno)
│   ├── paymentSettlement.js   # saldar pagos aprobados y marcar review_reason
│   ├── transaction.js         # withTransaction / rollbackWith (descarta conexiones rotas)
│   ├── lookupRotation.js      # rotación en memoria de consultas a MP por referencia
│   ├── concurrency.js         # mapWithConcurrency
│   ├── productUpdateQuery.js  # UPDATE parcial de productos (+ expectedUpdatedAt)
│   ├── productPublishing.js   # regla de publicación: qué exige un producto activo
│   ├── productSqlFragments.js # SQL común de productos (texto limpio, stock por talle, binder de parámetros)
│   ├── adminProductQuery.js   # SQL del listado admin (filtros, stock efectivo, orden)
│   ├── catalogProductQuery.js # SQL del catálogo público (activos, talle/color, precio efectivo, facets)
│   ├── catalogFacets.js       # orden de los facets (talles XS<S<M…, colores)
│   ├── cloudinaryDestroy.js   # borrado de un asset de Cloudinary
│   ├── idempotency.js         # Idempotency-Key: replay del 201 (memoria + idempotency_keys, fail-open; la verdad está en ventas.idempotency_key)
│   ├── logger.js              # logs estructurados JSON, nivelados por LOG_LEVEL
│   └── mercadopago.js         # cliente de la API de Mercado Pago
│
├── qa/
│   ├── test-plan.md           # plan de pruebas (incluye TC-180–TC-193 de concurrencia y carga)
│   ├── load-test.js           # suite de carga y concurrencia sin dependencias
│   └── unit/*.test.js         # tests unitarios deterministas (`node --test qa/unit/*.test.js`)
│
└── docs/flows/
    ├── flow-checkout.md
    ├── flow-admin-assistant.md
    ├── flow-despliegue-produccion.md
    └── flow-concurrencia-carga.md   # capas de defensa ante carga y concurrencia
```

> Documentación del repo: este archivo (referencia técnica), `README.md` (entrada rápida),
> `docs/flows/` (flujos de negocio), `qa/test-plan.md` y `CHANGELOG.md`.

---

## 4. Arquitectura (MVC por capas)

```
HTTP request
   │
   ▼
routes/*           → define método + path, aplica middlewares
   │
   ▼
middleware/*       → authMiddleware (JWT→user_id→rol) + adminMiddleware (rol === 'admin')
   │
   ▼
controllers/*      → validación de input, forma de la respuesta { success, data } / { success:false, code, message }
   │
   ▼
services/*         → casos de uso de órdenes (transacciones, Mercado Pago), sin req/res
   │
   ▼
models/*           → acceso a PostgreSQL/Supabase (SQL parametrizado)
   │
   ▼
config/database.js → Pool de conexiones pg
```

- **Separación de capas**: routes → controllers → services → models. Los controllers de órdenes y
  productos no tocan la base; las reglas puras del checkout viven en `utils/` (testeadas en
  `qa/unit`). **Excepción**: `cloudinaryController` hace llamadas HTTP directamente.
- **Transacciones**: `utils/transaction.withTransaction` (BEGIN/COMMIT/ROLLBACK; si el ROLLBACK
  falla, la conexión se descarta con `release(err)`). Orden de bloqueo común: filas de `ventas` por
  `id`, filas de `productos` por `id` ascendente (evita deadlocks entre reserva, pago, cancelación y sweep).
- **Respuesta consistente**: todas las respuestas siguen `{ success: boolean, ... }`
  (`data`, `message`, `count/total/limit/offset` en listados).
- **Arranque ordenado** (`server.js`): primero `connectDB()` (con reintentos), recién entonces
  `app.listen`. Si la BD no conecta, el proceso sale con código 1.

---

## 5. Endpoints

### 5.1 Usuarios — `/api/users` (`userRoutes.js` → `userController.js`)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/users/auth/:userId` | **Bearer + admin** | Usuario por Supabase Auth ID. |
| GET | `/api/users` | **Bearer + admin** | Lista de perfiles (paginada `?limit&offset`, máx 100). |
| POST | `/api/users` | **Bearer + admin** | Legacy/obsoleto: devuelve nota de "crear vía Supabase Auth". |
| GET | `/api/users/:id` | **Bearer + admin** | Perfil por id. |
| PUT | `/api/users/:id` | **Bearer + admin** | Actualiza `name`/`role` (transacción, valida rol ∈ {user,admin}). |
| DELETE | `/api/users/:id` | **Bearer + admin** | Borra de `profiles` **y** `auth.users` (transacción). |

> Todas las respuestas de este router van con `no-store`: son datos personales.

### 5.2 Productos — `/api/products` (`productRoutes.js` → `productController.js`)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/products` | pública | Lista paginada (`?limit&offset`, máx 100), `ORDER BY created_at DESC`. `Cache-Control: public, max-age=10, stale-while-revalidate=30`. |
| GET | `/api/products/admin/list` | **Bearer + admin** | Listado del panel admin con filtros, orden y paginación en el servidor (incluye inactivos; sin caché; 120 req/min). Query estricto (400 `VALIDATION_ERROR`; vacío = sin filtro): `q` (≤ 100, substring del nombre sin distinguir mayúsculas; `%`/`_`/`` literales), `category` (igualdad exacta sobre la categoría normalizada: trim + espacios colapsados + 1ª mayúscula), `status` (`active`/`inactive`; NULL cuenta como `active`), `stock` (`in_stock` >0, `low_stock` 1–5, `out_of_stock` =0 sobre el stock efectivo: suma de `stockByOption` de la 1ª variante Talle si tiene valores numéricos, si no la columna `stock`), `sort` (`name`/`price`/`stock`/`category` × `_asc`/`_desc`; sin `sort` = `created_at DESC, id DESC`; texto en orden de code units, NULL al final; desempate `created_at DESC, id DESC`), `page` (default 1, máx 100000), `limit` (default 5, máx 50). Respuesta `{ success, items, total, page, limit, totalPages, facets: { categories } }`: `items` son filas de `productos` en snake_case con las columnas del listado admin (sin `public_id`/`created_at`; el front las mapea con `mapAdminProductRow`), `facets.categories` las categorías normalizadas distintas de TODO el catálogo (sin filtrar). Página fuera de rango → `items: []` con el `total` real. SQL en `utils/adminProductQuery.js`. |
| GET | `/api/products/catalog` | pública (anónima: ignora el token, **nunca** devuelve inactivos) | Catálogo de la tienda con filtros, orden y paginación en el servidor. Solo `status = 'active'` (un `status` NULL no se publica, igual que el filtro que usaba el front; `GET /api/products` sí lo cuenta como activo). 600 req/min por IP **y además un límite propio de 120 req/min por IP** (`products-catalog`: cada combinación de filtros es una clave de caché y, en frío, dos consultas); `Cache-Control: public, max-age=10` **sin `stale-while-revalidate`** + ETag (304 sin cuerpo; la URL completa, query string incluido, es la clave del caché HTTP). Caché de servidor en tres partes (todas LRU con tope): páginas con resultados (`catalog`, 200 entradas, `TTL.products` = 20 s), facets por categoría (`catalogFacets`, 100 entradas, 60 s: dependen solo de la categoría) y consultas SIN resultados (`catalogMisses`, 100 entradas, 10 s: una categoría inventada no ocupa lugar en la caché de páginas). Página y facets se piden **en serie** (una conexión del pool a la vez). La caché se vacía por completo en cambios del admin (alta, edición, borrado de producto) y cuando un movimiento de stock agota o revive un producto o un talle; una reserva o liberación común NO la vacía, así que el stock numérico visible puede atrasarse hasta ~20 s en el servidor más 10 s en el navegador/CDN (peor caso ≈ 30 s). Query estricto (400 `VALIDATION_ERROR` con `details[].field`; vacío = sin filtro; desconocido, `sort`/`offset`/`limit` repetidos o con forma de objeto = 400): `category` (nombre; **repetir el parámetro** para varios: `?category=Ropa&category=Remeras`, máx 40 de ≤ 100 caracteres; igualdad sin distinguir mayúsculas sobre el texto con trim y espacios colapsados; no se parte por comas), `size` y `color` (repetibles, máx 12 de ≤ 20 / ≤ 40; OR entre los valores de un mismo parámetro, AND entre parámetros), `sort` (`newest` default = `created_at DESC, id DESC`; `price_asc`, `price_desc`, `name_asc`, `name_desc`; el orden por nombre ignora mayúsculas y tildes; desempate siempre `created_at DESC, id DESC`), `offset` (default 0, máx **2400** = 100 páginas de 24; no se exige múltiplo de `limit` porque el front pide con `offset` = filas ya recibidas) y `limit` (default 24, máx 48). **Precio de orden** = el que ve y paga el cliente (`resolveUnitPrice`): `price` si hay `original_price` mayor (el tachado es solo referencia); si no, `price` con `discount` % aplicado y redondeado a centavos. No usa `transfer_price`. **Talle**: variante cuyo nombre empieza con "talle" (la primera con opciones); un talle cuenta si tiene stock > 0 en `stockByOption`; si el producto no lleva stock por talle (ningún número en `stockByOption`) sus talles valen lo que la columna `stock`; con stock por talle, una opción sin número = sin stock. Sin variante de talle, el producto no matchea ningún `size`. Se compara en mayúsculas. **Color**: sin distinguir mayúsculas; los colores de un talle son `colorsByOption[talle]` (en la variante de talle) y, si ese talle no tiene, las opciones de la variante `Color`. Un color matchea solo si lo ofrece algún talle con stock; con `size` y `color` juntos exige la MISMA combinación ("M y Rojo" = M con stock en Rojo). Respuesta `{ success, items, hasMore, facets: { sizes, colors } }`: `items` son filas de `productos` en snake_case con exactamente `id, name, price, original_price, transfer_price, image_url, images, category, discount, stock, hover_image_enabled, card_options, variants` (los numéricos salen como número; `id` como string, igual que el resto de la API; `variants` completo), listas para `mapDbRowToProduct`. `hasMore` sale de pedir `limit + 1` filas (sin COUNT). `facets` = talles (mayúsculas; XS<S<M<L…, luego numéricos) y colores (alfabético) con stock del conjunto filtrado SOLO por categoría (no por `size`/`color`), para poblar los selectores. SQL en `utils/catalogProductQuery.js` (fragmentos comunes con el listado admin en `utils/productSqlFragments.js`). |
| GET | `/api/products/:id` | pública | Producto por id. `:id` no numérico → **400 `INVALID_PRODUCT_ID`**. `Cache-Control: public, max-age=5` sin `stale-while-revalidate` (es donde se decide comprar; peor caso de atraso del stock ≈ 5 s + 20 s del servidor). |
| POST | `/api/products` | **Bearer + admin** | Crea producto. Requiere `name` y `price`. Si queda `active` (o sin `status`), exige además categoría, foto, color y talle con stock: si falta algo → **400 `PRODUCT_INCOMPLETE`** (ver regla de publicación abajo). |
| PUT | `/api/products/:id` | **Bearer + admin** | Update dinámico (solo campos presentes: sin `stock` en el body, la columna `stock` no se toca). `expectedUpdatedAt` (el `updated_at` que leyó el admin, ISO con microsegundos) es **obligatorio si el body trae `stock` o `variants`** (400 `VALIDATION_ERROR` si falta) y opcional en el resto: si no coincide con el actual → **409 `PRODUCT_CHANGED`** sin modificar nada (comparación atómica en el mismo UPDATE). Si el producto resultante queda `active` e incompleto → **400 `PRODUCT_INCOMPLETE`** y rollback. |
| DELETE | `/api/products/:id` | **Bearer + admin** | Borra el producto y después su imagen en Cloudinary (best-effort). Con ventas `pendiente` del producto → **409 `PRODUCT_HAS_PENDING_ORDERS`** (no borra). |

Body de create/update (camelCase → columnas snake_case): `name`, `price`, `stock`, `category`,
`imageUrl`/`images[]` (se sincroniza `image_url` con la primera), `publicId`, `description`,
`discount` (admite null), `condition` (`new`/`used`), `freeShipping`, `variants`,
`specifications`, `features`, `faqs` (JSONB), `warranty`, `returnPolicy`, `status`.

**Regla de publicación** (`utils/productPublishing.js`, misma regla que el front): `inactive` es un
borrador y no exige nada más que el schema. Un producto `active` (o con `status` NULL) tiene que
tener categoría, al menos una foto (`images[]` o `image_url`), al menos un color (variante `Color`
con opciones o `colorsByOption` en algún talle) y una variante de talle con stock total > 0. Se
valida la fila **ya escrita** (`RETURNING *`) dentro de la transacción de `Product.create` /
`Product.update`, así que cubre los updates parciales; si falta algo se hace rollback y se responde
**400 `PRODUCT_INCOMPLETE`** con `details[0].field` = `category` | `images` | `color` | `sizes` | `stock`.
Las compras no pasan por acá: un producto activo puede quedar sin stock por ventas (se muestra
"Sin stock"), y para volver a editarlo hay que reponer un talle o pasarlo a `inactive`.

### 5.2b Talles — `/api/sizes` (`sizeRoutes.js` → `sizeController.js`)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/sizes` | pública (`optionalAuth`, caché 30 s) | Todos los talles (activos e inactivos), orden `type, garment` (sin prenda primero)`, name`: `{ id, name, type, garment, measurements, active, createdAt, updatedAt }`. |
| POST | `/api/sizes` | **Bearer + admin** | Crea `{ name, type, garment?, measurements? }` (`name` en mayúsculas; `garment` = prenda opcional de 1-30 caracteres, se guarda como se escribe, vacío = `null`). Duplicado `type`+prenda+nombre (sin distinguir mayúsculas) → **409 `SIZE_DUPLICATE`**. |
| PUT | `/api/sizes/:id` | **Bearer + admin** | Update parcial (`name`, `type`, `garment` —`null` la borra—, `measurements`, `active`). Id inexistente → **404 `SIZE_NOT_FOUND`**; id no UUID → **400 `INVALID_SIZE_ID`**. |

No hay DELETE: se desactiva con `active: false`. El catálogo se usa desde la guía de talles del producto: los talles globales se eligen como columnas y los específicos se crean en el formulario del producto; la guía se guarda en `productos.size_guide` (body `sizeGuide`, `schemas/sizeGuideSchema.js`): `type`, `columns`, `rows` y `columnSources` (columna → `{ sizeId }`) pasan sin validar forma ni verificarse contra el catálogo (compatibilidad con guías guardadas); los bloques informativos opcionales sí se validan estrictos: `unit` (`cm`/`mm`), `measurementBasis` (`body`/`garment`), `notes` (≤ 8 × 300), `fitReferenceMode` (`custom`/`hidden`) y `fitReference` (altura entera 100–230, talles ≤ 20, calce ≤ 60, notas ≤ 300, `image` solo https). `variants[].optionMeta` de `/api/products` (talle `global` con `sizeId` o `custom` con medidas) sigue aceptado y validado en el borde (un `sizeId` inexistente → **400 `SIZE_NOT_FOUND`**), pero el frontend ya no lo envía ni lo usa; se mantiene por compatibilidad. La variante Talle del producto es de texto libre con stock y no depende del catálogo.

### 5.3 Órdenes y pagos — `/api/orders` (`orderRoutes.js` → `orderController.js`)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/orders/mp-webhook` | pública (server a server) | Notificación de Mercado Pago; verifica el pago contra la API de MP y marca las ventas. Rate limit 240/min. **Firma**: con `MP_WEBHOOK_SECRET` se valida `x-signature` (HMAC) y su `ts` debe tener ≤ 5 min de antigüedad (también si viene del futuro más que eso) → si no, **401 `INVALID_SIGNATURE`**. **Sin `MP_WEBHOOK_SECRET` y `NODE_ENV=production` falla cerrado: 401 `WEBHOOK_NOT_CONFIGURED`** (alerta `mp_webhook_secret_missing` una vez por proceso; los pagos igual se confirman por `mp-confirm` y por el sweep). En desarrollo/test sin secreto sigue permisivo con el warning `mp_webhook_unsigned_allowed`. |
| POST | `/api/orders/transfer` | **Bearer** | Crea la orden por transferencia bancaria (el trigger de la BD descuenta stock). Errores de stock: ver abajo. |
| POST | `/api/orders/mp-preference` | **Bearer** | Valida stock con `SELECT … FOR UPDATE`, inserta ventas `pendiente` y crea la preferencia MP (`init_point`, `order_ids`). Errores de stock: ver abajo; **503** sin `MP_ACCESS_TOKEN`; **502 `MP_UNAVAILABLE`** si MP no responde (se libera la reserva). |
| POST | `/api/orders/mp-confirm` | **Bearer** | Confirma el pago verificándolo contra la API de MP (no confía en la URL de retorno) y **compara el monto acreditado** con el total de las órdenes: si no coincide, **409 `AMOUNT_MISMATCH`** y las ventas quedan `review_reason='amount_mismatch'`. `orders_paid` = ventas realmente pasadas a `pagado` en esta llamada (0 si ya estaban pagadas). **Solo salda pagos de compras propias**: si alguna venta del `external_reference` del pago no es del usuario (mismo email que el comprador) ni de un admin → **403 `FORBIDDEN`** y no se salda nada (IDOR). |
| POST | `/api/orders/mp-cancel` | **Bearer** | Body `{ orderIds: string[] }` (1..50 uuids; si no → **400 `INVALID_ORDER_IDS`**). Cancela las compras MP de esas ventas consultando a MP **una vez por compra** (`mp_external_reference`) antes de abrir la transacción. `200 { success: true, outcome }` con `outcome` ∈ `released` (canceló y devolvió stock, o ya estaba cancelada/expirada) · `held` (pago en curso o MP no respondió: no cancela) · `paid` (pago aprobado: se salda, no cancela); agregado con precedencia `paid > held > released`. Alguna venta ajena (y no admin) → **403 `FORBIDDEN`** sin tocar nada; ids inexistentes se ignoran. Rate limit de mutaciones. |
| GET | `/api/orders/user?email=` | **Bearer** | Compras del usuario: `pagado` + transferencias con comprobante avisado (`origin='wa_confirmado'`, cualquier `payment_status`). Solo el dueño o un admin (ajeno → **403**). |
| POST | `/api/orders/nudge` | **Bearer** | Registra el recordatorio de pago pendiente. `orderIds` deben ser uuids (si no → **400 `INVALID_ORDER_IDS`**). |
| POST | `/api/orders/:id/cancel` | **Bearer** | Cancela una orden propia y restaura stock, total y por talle (ajena → **403**, inexistente → **404**, no MP → **409**). Antes consulta a MP sin retener conexión del pool: pago aprobado → se salda y **409**; pago en curso → `200 { released: false }` sin cancelar. |
| PATCH | `/api/orders/:id/confirm-transfer` | **Bearer + admin** | Confirma la transferencia → `pagado` (no re-descuenta stock). Ya resuelta → **409**. |
| PATCH | `/api/orders/:id/cancel-transfer` | **Bearer + admin** | Cancela la transferencia → `cancelado` + stock restaurado. |
| PATCH | `/api/orders/:id/confirm-late-transfer` | **Bearer + admin** | Confirma una transferencia **`expirado`** (pagó tarde): vuelve a descontar stock y pasa a `pagado`; si ya no hay unidades (o el producto se borró) queda `oversold = true`. `200 { success: true, oversold }`. Otro estado → **409 `ORDER_NOT_EXPIRED`**; no es transferencia → **409 `NOT_A_TRANSFER`**. |

`:id` de órdenes debe ser uuid: cualquier otro formato → **400 `INVALID_ORDER_ID`** (nunca 500).
Las respuestas de error de órdenes tienen la forma `{ success: false, code, message }`.

**Errores de stock de `mp-preference` / `transfer`** (`{ success:false, code, message, productId, size? }`):
`OUT_OF_STOCK` **409** (stock total insuficiente, producto inexistente o con `stock` NULL) ·
`SIZE_OUT_OF_STOCK` **409** (+`size`) · `SIZE_UNAVAILABLE` **409** (+`size`, el talle ya no existe) ·
`SIZE_REQUIRED` **400** (falta el talle de alguna unidad) · `INVALID_VARIANT` **400** (otra variante
sin elegir o con una opción inexistente) · `INVALID_PRODUCT_ID` **400** (`productId` no numérico) ·
`PRODUCT_UNAVAILABLE` **409** (precio no positivo). `message` es el texto humano de siempre.
`PRICE_CHANGED` **409** (`{ success:false, code, message, expectedTotal }`): el `totalPrice` del body
difiere del total que se cobraría (comparación exacta al centavo) (cambió un precio entre el carrito y la confirmación);
la reserva se deshace y no queda ninguna venta.
Otros: `VALIDATION_ERROR` 400, `INVALID_SHIPPING` 400, `PURCHASES_DISABLED` 403, `MP_NOT_CONFIGURED` 503.

**El importe lo decide el servidor.** `reserveOrders` lee `price`/`discount`/`original_price` en el
mismo `SELECT … FOR UPDATE` que bloquea el stock y recalcula `unit_price`/`total_price`; el
`unitPrice` del body se ignora. La regla replica `getProductPricing` del frontend
(`src/utils/pricing.ts`): **si cambia una, hay que cambiar la otra**. Con **transferencia**
(`POST /transfer`) se cobra `transfer_price` cuando está cargado, salvo que el precio vigente ya
sea menor (`resolvePaymentUnitPrice`, espejo de `getTransferUnitPrice` del front); Mercado Pago
siempre cobra el precio de lista. El medio lo define la ruta, no un campo del body. El
`totalPrice` del body no decide el cobro: solo se compara con el total calculado y, si difiere en
un solo centavo, responde 409 `PRICE_CHANGED`. Los precios con descuento se redondean a centavos. El costo de envío lo impone el
servidor desde la tarifa de `shippingController` (`local` 0, `correo` `CORREO_COST`); el método de
envío es una whitelist estricta (`Object.hasOwn`) y cualquier otro valor responde 400
`INVALID_SHIPPING`. El body se valida con Zod strict (`schemas/checkoutSchema.js`) antes de tomar locks. Un ítem sin `productId` se rechaza con 400: sin producto no hay precio verificable.
También salen de la base **el nombre y la imagen** de la venta y del ítem de MP (`productos.name` y
la primera de `images`, o `image_url`); `productName`/`productImage` del body se ignoran. La
selección de variantes (`unitsConfig`) se valida contra las variantes reales y se guarda saneada
(`[]` si el producto no tiene variantes). El email del comprador es el de la sesión
(`req.user.email`); el del body solo se usa si la sesión no trae email. Los productos se bloquean
en orden de `productId`.

Rate limits: checkout 12/min (`transfer`, `mp-preference`), mutaciones 40/min. Todo `no-store`. Carriles de concurrencia: `transfer` y `nudge` (no llaman a Mercado Pago) van al carril `local`; `mp-preference`, `mp-confirm`, `mp-cancel` y `/:id/cancel` al carril `checkout`; `mp-webhook` al `webhook`; los `PATCH` de admin al `admin`; los `GET` al `read`. Al cancelar una compra de MP (`mp-cancel`, `/:id/cancel`), si ya no queda ninguna venta pendiente de esa preferencia se la **expira en Mercado Pago** (`PUT /checkout/preferences/{id}`, timeout 4 s, sin esperar la respuesta y sin afectar la cancelación si falla; log `mp_preference_expired` / `mp_preference_expire_failed`). ⚠️ Esa llamada no se pudo validar contra Mercado Pago real.

`transfer` y `mp-preference` aceptan `Idempotency-Key`, respaldada por `ventas.idempotency_key` (índice único por usuario) y un advisory lock por usuario: replay del `201` mientras la orden siga pendiente; misma key con otro carrito → **422**; key inválida → **400**; orden ya pagada → **409** `CHECKOUT_ATTEMPT_CLOSED`; cancelada o vencida → intento nuevo. Ese mismo lock hace atómico el tope de reservas pendientes por usuario. Detalle en `docs/flows/flow-checkout.md`.
Además, `server.js` corre `expireStaleOrders` (`services/orderMaintenance.js`) cada 60 s: expira
pendientes vencidas (MP 15 min tras consultar a MP, con retención de hasta 24 h si hay un pago en
curso; transferencia 5 h) y restaura stock; cada 15 min concilia compras MP cerradas de las últimas
48 h por si MP acreditó un pago tarde. Detalle del flujo en `docs/flows/flow-checkout.md`.

### 5.4 Envíos — `/api/shipping` (`shippingRoutes.js` → `shippingController.js`)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/shipping?postalCode=` | pública | Cotización por código postal. Cacheable 5 min (`publicCache(300)`), rate limit 120/min. |

### 5.5 Analítica admin — `/api/admin/insights` (`insightsRoutes.js` → `insightsController.js`)
Todo el router es **Bearer + admin**, `no-store`, rate limit 60/min y con caché en memoria de 60 s.
Respuesta uniforme `{ success, insight }`.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/low-stock?threshold=` | Productos activos bajo el umbral (default 5, clamp 1–100). |
| GET | `/sales-today` | Facturación, pedidos y unidades pagadas del día. |
| GET | `/pending-payment` | Pedidos `pendiente` (split MP / transferencia). |
| GET | `/pending-pickups` | Retiros en local por WhatsApp pendientes de confirmar. |
| GET | `/top-products` | Top de unidades vendidas del mes vs. mes anterior. |
| GET | `/sales-growth` | Productos con mayor crecimiento vs. mes anterior. |
| GET | `/pickups-to-confirm` | Retiros en local pagados, pendientes de entrega. |

### 5.6 Cloudinary — `/api/cloudinary` (`cloudinaryRoutes.js` → `cloudinaryController.js`)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/cloudinary/config` | pública | `{ cloudName, apiKey }` — datos no sensibles que necesita el widget. Cacheable 5 min. |
| GET | `/api/cloudinary/images` | **Bearer + admin** | Lista recursos (`?folder&next_cursor`, Admin API). |
| GET | `/api/cloudinary/usage` | **Bearer + admin** | Uso de la cuenta (cuota de almacenamiento). |
| GET | `/api/cloudinary/folders` | **Bearer + admin** | Lista carpetas (`?path`). |
| POST | `/api/cloudinary/folders` | **Bearer + admin** | Crea carpeta. Body `{ path }`. |
| DELETE | `/api/cloudinary/folders` | **Bearer + admin** | Borra carpeta. Body `{ path }`. |
| POST | `/api/cloudinary/sign` | **Bearer + admin** | Firma SHA1 de los params recibidos + `CLOUDINARY_API_SECRET` (que nunca se expone). |
| POST | `/api/cloudinary/delete` | **Bearer + admin** | Borra imagen. Body `{ publicId }`. |

Rate limit 60/min: cada request consume cuota de la API de Cloudinary.

### 5.7 Utilidades
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Info de la API (`{ message, version }`). |
| GET | `/health` | Liveness (`{ status: 'OK', uptimeSeconds }`). El detalle (pool, carriles, cachés, circuito de MP, latencias por ruta) exige `x-health-token` en producción. |
| GET | `/ready` | Readiness: `SELECT 1` con plazo de 2 s. `200 READY` / `503 NOT_READY` (detalle con `x-health-token`). Para un monitor externo; el Health Check de la plataforma debería seguir en `/health`. |
| (cualquiera) | `*` | 404 `{ success:false, message:'Ruta no encontrada' }`. |

---

## 6. Autenticación y autorización

- **Origen del token**: el frontend obtiene el JWT de **Supabase Auth** y lo manda en
  `Authorization: Bearer <token>`.
- **`authMiddleware`**: **verifica el token contra Supabase Auth** (`GET /auth/v1/user` con el
  token como Bearer y la `SUPABASE_ANON_KEY` como `apikey`). Supabase valida firma, expiración y
  revocación. Con el `id` devuelto consulta `SELECT id, role, name FROM public.profiles WHERE id = $1`
  y setea `req.user = { id, name, email, role }`. Sin `SUPABASE_URL` / `SUPABASE_ANON_KEY`
  responde **503**; token ausente o inválido → **401**.
- **Caché de verificación**: el resultado se cachea por `CACHE_TTL_AUTH_SECONDS` (30 s por
  defecto, `0` desactiva) bajo una clave **SHA-256 del token** (nunca el token en claro), con
  single-flight para no disparar N verificaciones del mismo token en paralelo. La caché de sesiones
  admite 5000 entradas (LRU). **Caché negativa** (`caches.authRejected`, 5000 entradas, 45 s,
  `CACHE_TTL_AUTH_REJECTED_SECONDS`): un token que Supabase rechazó con un 4xx no se vuelve a
  consultar durante ese lapso (también en `optionalAuth` de las rutas públicas). Una falla de
  infraestructura (timeout, red, 5xx o 429 de Supabase) NO se cachea ni se toma por token inválido:
  responde 503 `AUTH_UNAVAILABLE` (o sigue anónimo en `optionalAuth`). Un token vacío, con espacios
  o caracteres de control, de más de 4096 caracteres o con `exp` vencido se descarta sin consultar.
  **Trade-off explícito**: un token revocado puede seguir siendo aceptado hasta que expire el TTL.
- **`adminMiddleware`**: debe ir después de `authMiddleware`; exige `req.user.role === 'admin'`
  (403 si no).
- **Cobertura**: la cadena protege las escrituras de productos, **todo** el router de usuarios
  completo, órdenes (salvo el webhook de MP), la analítica
  admin completa y Cloudinary salvo `/config`.

---

## 7. Modelo de datos (PostgreSQL / Supabase)

Acceso directo con `pg` al Postgres de Supabase (esquemas `public` y `auth`).

| Tabla | Esquema | Uso en el backend |
|---|---|---|
| `profiles` | public | `id UUID` (FK → `auth.users.id`, ON DELETE CASCADE), `name`, `role` (`user`/`admin`), `is_owner`, `purchase_allowed_exclusive`, `created_at`. RLS habilitada; política "Users see their profile". Índice `idx_profiles_role`. **Legacy sin usar** (no las referencia ningún archivo `.js`, vacías en el 100% de las filas): `email`, `password_hash` — restos de un sistema de auth propio reemplazado por Supabase Auth. |
| `auth.users` | auth | gestionada por Supabase Auth; se lee (`email`, `email_confirmed_at`) y se borra en cascada al eliminar perfil. |
| `productos` | public | CRUD vía `productController` → `models/Product.js`. `updated_at` lo actualiza en cada UPDATE el trigger `update_productos_updated_at` (también cuando una compra descuenta stock): es la base del control optimista `expectedUpdatedAt`. Columnas (incluidas por `init-db`): `name`, `price`, `stock`, `category`, `image_url`, `public_id`, `description`, `discount NUMERIC(5,2)`, `original_price NUMERIC(10,2)` (tachado; `price` es el final cobrado), `transfer_price NUMERIC(10,2)` (opcional, informativo: precio "con transferencia" que muestra el detalle; no lo usa el checkout), `condition`, `free_shipping`, `variants/specifications/features/faqs/images JSONB`, `warranty`, `return_policy`, `status`, `featured`, `created_at`, `updated_at`. |
| `ventas` | public | Una fila = una línea de producto vendido. `id`, `user_id` (FK → `auth.users.id`, `ON DELETE SET NULL`, agregada 2026-09-18), `buyer_name`/`buyer_email` (snapshot del comprador al momento de la venta, se conservan aunque el usuario cambie el email después), `product_id` (FK, `ON DELETE SET NULL`), `product_name`/`product_image` (desnormalizado), `quantity`, `unit_price`, `total_price`, `units_config JSONB`, `payment_method` (`mp`/`transfer`), `payment_status` (`pendiente`/`pagado`/`cancelado`/`expirado`), `shipping_method`, `dispatch_status`, `mp_preference_id`/`mp_external_reference`/`mp_payment_id` (preferencia, **id de compra** enviado a MP como `external_reference` —uuid compartido por las líneas del carrito; en ventas anteriores es la lista de ids de venta separados por coma— y pago que saldó la venta; migración 2026-10-13), `oversold` (pago acreditado sin stock: reembolsar), `review_reason` (NULL o `amount_mismatch` / `duplicate_payment` / `refunded` / `charged_back`: requiere revisión del admin; solo detección, no cambia estado ni stock; migración 2026-10-14), `origin` (respuesta al nudge de WhatsApp), `created_at`, `paid_at`/`cancelled_at`/`dispatched_at` (agregadas 2026-09-18, las completa el trigger `trg_set_ventas_status_timestamps`). Ver `models/Order.js`, `models/OrderPayment.js` y `services/`. |
| `idempotency_keys` | public | Respuestas `201` de `mp-preference`/`transfer` por `(scope, key)`: `fingerprint`, `status`, `body JSONB`, `created_at`. RLS activo sin policies (solo el backend). Se reutilizan 10 min; el sweep borra las de más de 24 h. Migración `2026-10-08_add_idempotency_keys.sql`; si falta, el backend usa solo memoria. |
| `ventas_archivadas` | public | **Legacy sin usar**: mismas columnas que `ventas` + `archived_at`, con RLS y GRANTs configurados, pero ningún archivo `.js` inserta en ella. |
| `email_tokens` / `refresh_tokens` | public | **Legacy sin usar**: 0 filas, sin código que las referencie. La confirmación de email y el reset de contraseña se resuelven contra la API de Supabase Auth (`authController.js`); la sesión usa el refresh token de Supabase en cookie httpOnly, no estas tablas. |
| `carousel_images` | public | creada por `init-db` (`id`, `url`, `order`, `is_active`, `created_at`; por migración también `device_type`, `kind` = `image`/`banner` y `design` jsonb con la composición de los banners editables, ver `2026-10-15_add_carousel_banner_slides.sql`; y `navbar_color` hex nullable con el color del menú sobre ese slide, ver `2026-10-16_add_navbar_color_to_carousel_images.sql`). La escribe el frontend directo (RLS: solo admin escribe); el backend solo la crea. |

**Trigger** (`init-db`): `on_auth_user_created` → `handle_new_user()` inserta una fila en
`profiles` (rol `user`) cada vez que se crea un usuario en `auth.users`.

**Trigger** (`db/migrations/2026-09-18_add_status_timestamps_to_ventas.sql`):
`trg_set_ventas_status_timestamps` completa `paid_at`/`cancelled_at`/`dispatched_at` cuando
`payment_status`/`dispatch_status` cambian — cubre tanto los cambios que hace el backend
(`payment_status`) como los que hace el panel admin directo contra Supabase con la anon key
(`dispatch_status`, sin endpoint propio en este repo).

> El esquema "fuente de verdad" lo administra Supabase; `init-db` es idempotente
> (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) y sirve para alinear una BD nueva.
> Los cambios de schema puntuales (nuevas columnas, triggers) viven en `db/migrations/*.sql`,
> con instrucciones de aplicación manual vía Supabase SQL Editor en cada archivo.

---

## 8. Configuración (variables de entorno)

Definidas en `.env` (plantilla en `.env.example`). Los datos se leen por **conexión directa a
Postgres** (`DB_*`); `SUPABASE_URL` / `SUPABASE_ANON_KEY` se usan **solo** para verificar tokens
de Supabase Auth y para el login.

| Variable | Requerida | Uso |
|---|---|---|
| `NODE_ENV` | — | `development`/`production` (controla verbosidad de errores). |
| `PORT` | — | Puerto HTTP (default `3000`). |
| `DB_HOST` | ✅ | Host de Postgres/Supabase. |
| `DB_PORT` | ✅ | Puerto (típicamente `5432`). |
| `DB_USER` | ✅ | Usuario (`postgres`). |
| `DB_PASSWORD` | ✅ | **Secreto.** Password de la BD. |
| `DB_NAME` | ✅ | Base (`postgres`). |
| `FRONTEND_URL` | ✅ (recomendada) | Allowlist de CORS (coma-separada). Default `http://localhost:5173`. |
| `CLOUDINARY_CLOUD_NAME` | ✅ (Cloudinary) | Cloud name. |
| `CLOUDINARY_API_KEY` | ✅ (Cloudinary) | API key. |
| `CLOUDINARY_API_SECRET` | ✅ (Cloudinary) | **Secreto.** Para firmar/borrar. |
| `SUPABASE_URL` | ✅ (auth) | Proyecto Supabase contra el que `authMiddleware` verifica los access tokens. Sin ella, toda ruta protegida falla. |
| `SUPABASE_ANON_KEY` | ✅ (auth) | Anon key usada en la verificación del token y en `userController`. |
| `MP_ACCESS_TOKEN` | ✅ (Mercado Pago) | **Secreto.** Sin ella, `/api/orders/mp-*` responde **503**; la transferencia bancaria sigue funcionando. |
| `MP_WEBHOOK_URL` | — | URL pública del webhook (`https://…/api/orders/mp-webhook`). En local no aplica salvo que expongas el backend por túnel. |
| `ORDER_SWEEP_MAX_MP_LOOKUPS` | — (default `10`) | Tope de consultas a MP por ciclo del sweep de pendientes vencidas (4 en paralelo). |
| `MP_WEBHOOK_SECRET` | — (**obligatoria en producción**) | **Secreto.** Firma del webhook (panel MP → Webhooks). Si está, se valida `x-signature` (HMAC y `ts` de ≤ 5 min) y se rechaza con **401** lo que no cuadre. Si falta con `NODE_ENV=production`, el webhook rechaza TODO con 401 `WEBHOOK_NOT_CONFIGURED`; fuera de producción sigue permisivo (revalida cada pago contra la API de MP). |

### 8.1 Concurrencia, carga y caché (opcionales)

Todas tienen default productivo; se listan para poder ajustar sin tocar código.
Detalle del mecanismo en [`docs/flows/flow-concurrencia-carga.md`](docs/flows/flow-concurrencia-carga.md).

| Variable | Default | Uso |
|---|---|---|
| `DB_POOL_MAX` | `12` | Conexiones máximas del pool. **Techo real: 15** — el pooler de Supabase en modo sesión responde `EMAXCONNSESSION` al pasarse. |
| `DB_POOL_MIN` | `2` | Conexiones tibias para no pagar handshake en cada pico. |
| `DB_IDLE_TIMEOUT_MS` | `30000` | Cierre de conexiones ociosas. |
| `DB_CONNECTION_TIMEOUT_MS` | `5000` | Espera máxima por una conexión del pool. |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` | Corta queries colgadas del lado del servidor Postgres. |
| `DB_QUERY_TIMEOUT_MS` | `10000` | Ídem del lado del cliente `pg`. |
| `BULKHEAD_<CARRIL>_MAX` / `_QUEUE` | `read`: 6 / 200 · `auth`: 3 / 50 · `admin`: 3 / 20 · `checkout` (con Mercado Pago): 4 / 50 · `local` (transferencia y nudge, sin MP): 2 / 50 · `webhook`: 3 / 50 | Handlers simultáneos y cola de cada carril del bulkhead. Al llenarse la cola se responde **503 + `Retry-After`**. **Regla**: un slot de `read`/`admin` usa como máximo una conexión del pool a la vez, y `read`+`auth`+`admin` comparten un presupuesto de conexiones (`BULKHEAD_GENERAL_MAX`, por defecto `DB_POOL_MAX - BULKHEAD_CRITICAL_DB_RESERVE`) para que checkout, órdenes locales y webhook siempre encuentren conexión libre aunque el tráfico público sature. |
| `BULKHEAD_CRITICAL_DB_RESERVE` | `5` | Conexiones del pool reservadas a `checkout`/`local`/`webhook`; el grupo `general` (`read`+`auth`+`admin`) puede usar `DB_POOL_MAX` menos esto (mínimo 2). |
| `BULKHEAD_GENERAL_MAX` | `DB_POOL_MAX - BULKHEAD_CRITICAL_DB_RESERVE` | Tope conjunto del grupo `general`. Aparece en `/health` como carril `general`. |
| `MAX_CONCURRENT_REQUESTS` / `MAX_QUEUED_REQUESTS` | `6` / `200` | Valores del carril `read` (compatibilidad con el bulkhead único anterior). |
| `QUEUE_TIMEOUT_MS` | `8000` | Espera máxima en cola (todos los carriles) antes de devolver 503. |
| `SLOW_REQUEST_MS` | `1000` | Umbral para loguear una request como lenta. |
| `ACCESS_LOG_ALL` | `false` | `true` loguea todas las requests (solo para una prueba de carga puntual). |
| `CACHE_TTL_PRODUCTS_SECONDS` | `20` | Caché del catálogo. `0` la desactiva. Se vacía en cambios del admin y cuando un movimiento de stock agota/revive un producto o talle; las reservas comunes no la vacían (el stock numérico puede atrasarse hasta este TTL). |
| `CACHE_TTL_CATALOG_FACETS_SECONDS` | `60` | Caché de talles/colores por categoría del catálogo. |
| `CACHE_TTL_CATALOG_MISSES_SECONDS` | `10` | Caché de consultas del catálogo sin resultados. |
| `CACHE_TTL_INSIGHTS_SECONDS` | `60` | Caché de la analítica admin. |
| `CACHE_TTL_AUTH_SECONDS` | `30` | Caché de verificación de token. ⚠️ Un token revocado sigue siendo válido como máximo este tiempo. |
| `CACHE_TTL_AUTH_REJECTED_SECONDS` | `45` | Caché negativa: cuánto se recuerda que Supabase rechazó un token (por hash). `0` la desactiva. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

`GET /health` expone en vivo el estado del pool, de cada carril del bulkhead, del rate limit, de las cachés, del circuito de Mercado Pago y las latencias por ruta.

> El pool de `pg` usa `ssl: { rejectUnauthorized: false }`.
>
> CORS (`config/cors.js`): en `NODE_ENV != production` se acepta **cualquier** origen
> `localhost` / `127.0.0.1` en cualquier puerto (Vite salta a 5174 si 5173 está ocupado),
> además de la allowlist de `FRONTEND_URL`. En producción, solo la allowlist.

---

## 9. Cómo levantar el proyecto

Requisito: **Node 22.x** (`.nvmrc` y `engines.node`).

```powershell
# Desde la raíz del repo backend
cd "BACK/lia-store"

# 1. Instalar dependencias
npm install

# 2. Crear .env a partir de .env.example y completar:
#    DB_* · FRONTEND_URL · CLOUDINARY_* · SUPABASE_URL · SUPABASE_ANON_KEY · MP_ACCESS_TOKEN

# 3. (Solo en una BD nueva) alinear el esquema — idempotente
npm run init-db

# 4. Levantar
npm run dev      # nodemon, recarga al guardar
npm start        # node server.js (producción)
```

Queda escuchando en **http://localhost:3000**, con la API bajo **`/api`**.

```powershell
# Verificación rápida
curl http://localhost:3000/health      # → { "status": "OK" }
```

Al arrancar, `server.js` primero conecta a Postgres (`connectDB`): si la BD no responde, el
proceso **sale con código 1** y no levanta el servidor. Además arranca el sweep de órdenes
(`expireStaleOrders`) cada 60 s, que expira las pendientes vencidas y restaura stock.

### 9.1 Levantar el stack completo (backend + frontend)

Dos terminales, una por proceso:

```powershell
# Terminal 1 — backend (http://localhost:3000, API en /api)
cd "BACK/lia-store"; npm run dev

# Terminal 2 — frontend (http://localhost:5173)
cd "FRONT/damiana-bella"; npm run dev
```

El frontend vive en `../../FRONT/damiana-bella` (repo git propio) y apunta acá con
`VITE_API_URL_LOCAL=http://localhost:3000/api`.

### 9.2 Problemas frecuentes en local

| Síntoma | Causa probable | Solución |
|---|---|---|
| El proceso sale con `❌ No se pudo iniciar el servidor` | `DB_*` mal, proyecto Supabase pausado o sin red | Revisar credenciales; despausar el proyecto en Supabase |
| `503` en `/api/orders/mp-preference` o `mp-confirm` | Falta `MP_ACCESS_TOKEN` | Cargarlo en `.env` y reiniciar |
| `401` en rutas protegidas con un token válido | Faltan `SUPABASE_URL` / `SUPABASE_ANON_KEY` | Cargarlas en `.env` y reiniciar |
| El navegador bloquea las requests por CORS | Front en un origen no permitido con `NODE_ENV=production` | Usar `NODE_ENV=development` en local o sumar el origen a `FRONTEND_URL` (CSV, sin espacios) |
| `relation "profiles" does not exist` | BD nueva sin esquema | `npm run init-db` |
| El front pega a un puerto que nadie escucha | Vite tomó 5174 y/o `VITE_API_URL_LOCAL` desactualizada | Verificar el puerto real que imprime Vite y la URL del `.env.local` del front |

> **Antes de integrar contratos con el frontend, leé la §11.**

---

## 10. Seguridad — estado actual

> Referencia: `../../skill/04-security.md`. Verificado contra el código.

**Resuelto** (los hallazgos originales de esta sección ya no aplican):

- **Verificación del token**: `authMiddleware` valida contra Supabase Auth, no decodifica sin
  verificar. Ver §6.
- **Rutas de usuarios protegidas**: todo el CRUD de `/api/users` exige Bearer + rol admin.
- **`login` valida credenciales** contra Supabase Auth (`grant_type=password`).
- **`.env.example` con placeholders**, sin credenciales reales.
- **Rate limiting por endpoint** con ventana deslizante y headers estándar (`middleware/rateLimit.js`),
  más estricto en login (10/min) y checkout (12/min). El store tiene tope duro de 20 000 claves
  (descarta la más antigua al llenarse), agrupa las IPv6 por /64 y el log de bloqueo
  (`rate_limit_blocked`) lleva un hash de la clave, no la IP ni el id de usuario.
- **Logs estructurados** (`utils/logger.js`) sin tokens ni PII; la caché de auth indexa por
  SHA-256 del token.
- **SQL parametrizado** en todas las queries; transacciones y `FOR UPDATE` en el stock.
- **Precio e importe decididos por el servidor** en el checkout, y monto del pago contrastado
  contra el total de las órdenes antes de marcarlas pagadas (ver §5.3).
- **CORS con allowlist** por `FRONTEND_URL` (nunca `*` en producción).

- **Headers de seguridad** en toda respuesta (`middleware/securityHeaders.js`): CSP restrictiva,
  `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, CORP y HSTS cuando se sirve por HTTPS.
- **Firma del webhook de MP** verificada con HMAC-SHA256, comparación en tiempo constante y
  antigüedad máxima de 5 min del `ts`; sin `MP_WEBHOOK_SECRET` en producción el webhook falla cerrado.
- **`npm run audit`** (`--audit-level=high`) disponible como paso previo al deploy.
- **Manejo de errores sin fuga de internals** en todos los controllers (`userController`,
  `cloudinaryController`, `productController`): el detalle real (mensaje de Postgres, respuesta
  cruda de Cloudinary) va al log estructurado; el cliente recibe un mensaje genérico o, cuando
  el error es de validación de dominio conocida, un mensaje acotado y seguro.
- **Validación de borde con Zod** en `/api/products` (`schemas/productSchema.js` +
  `middleware/validateBody.js`): tipos, rangos y longitudes antes de tocar la base.
- **Sin path traversal en carpetas de Cloudinary**: `path` se valida por segmento (sin `..`,
  charset acotado) antes de armar la ruta a la API de Cloudinary.
- **Bloqueo progresivo de login por email** (`middleware/loginBruteforce.js`), además del rate
  limit por IP: frena fuerza bruta distribuida contra una misma cuenta.

**RLS y permisos de Supabase** — ver `db/migrations/2026-08-09_rls_hardening.sql`. La `anon key`
es pública (viaja en el bundle del front), así que todo lo que `anon`/`authenticated` puedan hacer
en la base lo puede hacer cualquiera. La migración activa RLS en las tablas que no la tenían,
acota los `GRANT` y **revoca `TRUNCATE`** (que no está sujeto a RLS). El backend conecta como
`postgres` (dueño), así que no le afecta.

**Pendiente / a vigilar:**

1. **Historial de git con credenciales**: `README.md`, `QUICKSTART.md` y `VERIFICATION_CHECKLIST.md`
   tuvieron el host y la password de la BD en claro. Los archivos ya se limpiaron/eliminaron, pero
   **siguen en el historial de ambos remotos** (`origin` y `lia-back`). **Rotar la password de la BD**
   es obligatorio; borrar el archivo no alcanza.
2. **TTL de la caché de auth**: un token revocado sigue siendo válido hasta 30 s
   (`CACHE_TTL_AUTH_SECONDS`). Aceptable para este dominio; bajarlo a `0` si alguna vez importa
   la revocación inmediata.
3. **Auditoría de dependencias**: no hay `npm audit` en un pipeline automático.
4. **Rate limit y bloqueo de login en memoria de proceso**: correcto con una sola instancia
   (Railway hoy); con más de una instancia hay que mover esos stores a algo compartido (Redis).
   Los stores (`loginBruteforce`, `emailActionLimiter`) tienen tope duro de entradas y purga
   periódica (`utils/boundedStore.js`), pero se pierden en cada reinicio.

---

## 11. Contrato con el frontend

El frontend (`../../FRONT/damiana-bella`, repo propio) y este backend están **alineados**:

- **Auth**: el front habla con `/api/auth/*` (`login`, `refresh`, `logout`, `resend-confirmation`,
  `forgot-password`). El backend valida contra Supabase Auth, entrega el access token en el body y
  guarda el refresh token en una cookie httpOnly; el front lo mantiene solo en memoria y adjunta el
  access token a cada request (ver §4 y `routes/authRoutes.js`). El registro y la confirmación de
  email siguen yendo directo a Supabase Auth.
- **Órdenes, envíos, insights y Cloudinary**: implementados (§5.3 a §5.6) y consumidos por
  `src/services/orderService.ts`, `shippingService`, `insightsService` y `productService`.
- **Transferencias**: el front **no** inserta en `ventas` directo por Supabase (lo bloqueaba RLS);
  usa `POST /api/orders/transfer`, que corre con el pool del backend.
- **Vuelta de MP sin pagar**: la `external_reference` que vuelve en la URL ya **no** son ids de
  venta (es el id de compra). El front debe cancelar con `POST /api/orders/mp-cancel` usando los
  `order_ids` que guardó al crear la preferencia (no parsear `external_reference`).
- **Errores con `code`**: el checkout devuelve `code` estable (`OUT_OF_STOCK`, `SIZE_OUT_OF_STOCK`,
  `SIZE_UNAVAILABLE`, `SIZE_REQUIRED`, …) además de `message`; `PUT /api/products/:id` acepta
  `expectedUpdatedAt` y puede responder `409 PRODUCT_CHANGED`; `ventas.review_reason` y
  `PATCH /:id/confirm-late-transfer` son para el panel Ventas.

> Al cambiar cualquier contrato de esta lista, actualizar también
> `../../FRONT/damiana-bella/DOCUMENTACION_FRONTEND.md` §6 en el mismo cambio.

---

## 12. Patrones y buenas prácticas detectadas

- **SQL parametrizado** en todos los `pool.query` (productos, usuarios) → mitiga inyección SQL.
- **Transacciones** (`BEGIN/COMMIT/ROLLBACK`) en update/delete de usuarios.
- **Pool de conexiones** configurado (max 20, timeouts) y `connectDB` con reintentos + diagnóstico.
- **Update dinámico** de productos (solo persiste campos presentes en el body).
- **Respuesta uniforme** `{ success, ... }` y paginación con `limit/offset` (máx 100).
- **CORS con allowlist** por `FRONTEND_URL` (no `*`).
- **Errores genéricos al cliente en producción** (`NODE_ENV`), detalle solo en dev.
- **`init-db` idempotente** para alinear esquema sin romper datos existentes.

---

## 13. Skills senior

El contrato de calidad senior se carga automáticamente vía [CLAUDE.md](CLAUDE.md), que importa
los skills compartidos desde `../../skill/`. Para backend aplican principalmente: `00-role`,
`01-backend`, `03-testing-qa`, `04-security`, `06-restrictions`, `07-senior-rules`,
`08-delivery-format`, `09-protocols`, `10-documentation`, más `11-bug-hunter` y `12-judge-architect`.
