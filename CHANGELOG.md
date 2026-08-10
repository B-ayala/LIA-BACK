# 📋 Registro de Cambios - Migración MongoDB → PostgreSQL/Supabase

## [Unreleased]

### Added
- **Manejo de concurrencia y carga en toda la API** (ver
  `docs/flows/flow-concurrencia-carga.md`, casos QA `TC-180`–`TC-193`):
  - **Control de concurrencia (bulkhead + cola)**: como máximo
    `MAX_CONCURRENT_REQUESTS` handlers tocan la base a la vez; el excedente
    espera en una cola acotada y, si se llena, recibe **503 `SERVER_BUSY` con
    `Retry-After`** en lugar de degradarse en timeouts.
  - **Caché en memoria con TTL y single-flight** para catálogo, detalle de
    producto y analítica admin: N lecturas simultáneas iguales ejecutan una sola
    query. Se invalida automáticamente ante cualquier cambio de producto o stock
    (alta/edición/baja, reserva, cancelación, pago tardío, sweep de expiración).
  - **Caché de verificación de token** (`CACHE_TTL_AUTH_SECONDS`, 30 s): evita un
    round trip HTTPS a Supabase Auth + una query a `profiles` en cada request
    autenticada. Sólo se cachean verificaciones exitosas.
  - **Rate limiting por endpoint** (ventana deslizante) con `429`,
    `Retry-After` y headers `X-RateLimit-*`: login 10/min, checkout 12/min,
    insights 60/min, catálogo 600/min, más un techo global de 1200/min.
  - **Caché HTTP**: `Cache-Control` + `ETag` en endpoints públicos (catálogo,
    envío, config de Cloudinary) → revalidaciones responden **304 sin cuerpo**.
    `no-store` explícito en órdenes, usuarios, insights y Cloudinary admin.
  - **Compresión gzip** de las respuestas (nueva dependencia `compression`).
  - **Paginación** en `GET /api/orders/user` (`limit`/`offset`/`total`/`hasMore`,
    default 200, máx. 500) y tope de 50 ítems por compra.
  - **Apagado ordenado** ante `SIGTERM`/`SIGINT`: deja de aceptar, drena las
    requests en vuelo y cierra el pool (evita cortar compras en cada deploy).
  - **`GET /health` con métricas** de pool, bulkhead, rate limit y cachés; queda
    fuera del rate limit y del bulkhead para poder diagnosticar bajo saturación.
  - Timeouts de servidor (`keepAlive` 65 s, `requestTimeout` 30 s) y de base
    (`statement_timeout` / `query_timeout` 10 s), y límite de body de 256 kb con
    respuestas tipadas `413 PAYLOAD_TOO_LARGE` / `400 INVALID_JSON`.
- **Índices de soporte** en `db/migrations/2026-08-08_add_performance_indexes.sql`
  para las consultas calientes de `ventas` y `productos` (idempotentes).
- `qa/load-test.js`: nueva SUITE 7 que verifica caché HTTP, 304, compresión,
  rate limit y métricas de `/health`.

### Changed
- `DB_POOL_MAX` baja de 20 a **12**: el pooler de Supabase en modo sesión limita
  el proyecto a 15 clientes y devolvía `EMAXCONNSESSION` bajo carga (36 errores
  reproducidos con 800 requests concurrentes; con 12 el mismo escenario da 0).
  Todo el tuning del pool pasa a ser configurable por entorno.
- `POST /api/orders/mp-preference`: la llamada a Mercado Pago sale **fuera** de
  la transacción, que ahora es corta (reservar stock → COMMIT → llamar a MP). Si
  MP falla, se compensa cancelando las reservas y devolviendo el stock. El
  contrato y los estados observables no cambian; antes cada checkout retenía una
  conexión del pool durante todo el round trip externo.
- Creación de órdenes (MP y transferencia): las requests duplicadas del mismo
  usuario con el mismo carrito que llegan mientras la primera sigue en vuelo
  comparten esa ejecución, en vez de crear dos juegos de ventas y descontar
  stock dos veces (doble click en "Pagar").
- `GET /api/products`: el total viaja en la misma consulta (`COUNT(*) OVER()`),
  eliminando el segundo round trip por request, y la respuesta suma `hasMore`.
- Logs del servidor pasan a formato estructurado JSON en producción
  (`utils/logger.js`, nivel configurable con `LOG_LEVEL`).
- `authMiddleware`: "Usuario no encontrado en la base de datos" se unifica en
  "Token inválido o expirado" (no revela si el perfil existe).

### Security
- `userController` y `cloudinaryController` devolvían `error.message` crudo en
  sus respuestas de error (detalle de Postgres, de la API de Cloudinary, etc.).
  Ahora responden un mensaje genérico y el detalle va al log estructurado,
  igual que ya hacía `productController`.
- `middleware/authMiddleware.js`: se elimina `errorHandler`, código muerto (sin
  ninguna referencia) que además filtraba `err.stack`/`err.message` con una
  política distinta a la del error handler real de `server.js`.
- `POST/DELETE /api/cloudinary/folders` y `GET /api/cloudinary/folders`:
  el `path` de carpeta se saneaba con `encodeURIComponent` pero no rechazaba
  segmentos `..`, permitiendo escapar del namespace de carpetas esperado en
  Cloudinary. Ahora se valida cada segmento contra un allowlist de caracteres.
- `POST/PUT /api/products`: validación de borde con Zod
  (`schemas/productSchema.js` + `middleware/validateBody.js`) — tipos, rangos
  numéricos y longitudes máximas antes de tocar la base.
- Login (`POST /api/users/login`): bloqueo progresivo por email
  (`middleware/loginBruteforce.js`) además del rate limit por IP ya existente,
  para frenar fuerza bruta distribuida contra una misma cuenta.

### Fixed
- Los errores 500 de `productController` devolvían `error.message` crudo, lo que
  filtraba detalle de infraestructura al cliente (por ejemplo el `pool_size` de
  Supabase). Ahora responden `{ code: 'INTERNAL_ERROR' }` genérico y el detalle
  va al log.
- `middleware/concurrencyLimit.js`: un cliente que se desconectaba mientras su
  request esperaba en la cola dejaba el slot tomado (el evento `close` ya había
  ocurrido antes de registrar los listeners de liberación).
- `Bulkhead.stats()` pisaba la profundidad instantánea de la cola con el
  contador acumulado del mismo nombre; ahora son `queueLength` y `totalQueued`.
- `controllers/cloudinaryController.js`: se elimina el `console.log` que imprimía
  la firma generada para Cloudinary.
- `qa/load-test.js`: las suites 3 y 6 apuntaban a endpoints que este backend no
  expone (`/products/carousel`, `/site-content`) y usaban `?cp=` en vez de
  `?postalCode=`, por lo que reportaban 100% de error de forma permanente.
- `npm audit`: `body-parser` actualizado (advisory de DoS al deshabilitarse
  silenciosamente el límite de tamaño). Sin vulnerabilidades abiertas.
- `DOCUMENTACION_BACKEND.md` §8: la tabla de variables de entorno suma `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `MP_ACCESS_TOKEN` y `MP_WEBHOOK_URL` (estaban en uso pero sin
  documentar) y aclara el comportamiento de CORS en desarrollo.
- `DOCUMENTACION_BACKEND.md` §9 "Cómo levantar el proyecto": Node 22.x, comandos completos,
  nota sobre el arranque bloqueante por conexión a BD y el sweep de órdenes, nuevas
  §9.1 (stack completo backend + frontend) y §9.2 (tabla de problemas frecuentes en local).
- **Endurecimiento de RLS y permisos en Supabase** (`db/migrations/2026-08-09_rls_hardening.sql`,
  **pendiente de aplicar**). Auditoría del catálogo de la base: `profiles` tenía **RLS desactivada**
  con `UPDATE` concedido a `anon`/`authenticated` → cualquiera con la anon key (que es pública)
  podía hacer `UPDATE profiles SET role='admin'` y tomar el panel completo. Misma exposición en
  `ventas_archivadas` (34 filas con PII de compradores), `contact_messages`, `site_content`,
  `carousel_images`, `email_tokens` y `refresh_tokens`. Además `TRUNCATE` —que **no** respeta
  RLS— estaba concedido en todas las tablas. La migración activa RLS, define políticas
  self/admin y revoca los privilegios de más, preservando los accesos que hoy usa el frontend.
- **`ventas`: se elimina la política `ventas_insert_public`** (`CHECK (true)`): permitía insertar
  ventas con la anon key y, vía el trigger `trg_decrement_stock`, vaciar el stock sin comprar.
  Las altas ya van por `POST /api/orders/transfer`.
- **Headers de seguridad en toda respuesta** (`middleware/securityHeaders.js`): CSP, `nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Cross-Origin-Resource-Policy` y HSTS bajo HTTPS.
  Sin dependencias nuevas: para una API que solo devuelve JSON, `helmet` aportaba seis cabeceras
  y una dependencia más.
- **Firma del webhook de Mercado Pago verificada** (HMAC-SHA256 sobre el manifest de MP, con
  `crypto.timingSafeEqual`) cuando `MP_WEBHOOK_SECRET` está definida; si falta, se mantiene el
  comportamiento anterior (revalidación del pago contra la API de MP).
- **`npm run audit`** agregado (`--audit-level=high`). Estado actual: 0 vulnerabilidades.
- **El precio de la compra ya no lo define el cliente** (BUG-001, crítico). `unitPrice`,
  `totalPrice` y `shippingCost` llegaban en el body y se persistían sin contrastarlos contra
  `productos`: cualquier usuario podía comprar por $1 manipulando el request. Ahora
  `reserveOrders` toma `price`/`discount`/`original_price` de la base en el mismo
  `SELECT … FOR UPDATE` que ya bloqueaba el stock y recalcula el importe server-side
  (misma regla que `getProductPricing` del frontend, incluidos descuentos y promociones).
  La preferencia de Mercado Pago se arma con esos precios, no con los del body.
- **Costo de envío validado contra la tarifa del servidor**: `local` = 0 y `correo` = `CORREO_COST`
  (importado de `shippingController`, fuente única); `moto` sigue siendo variable pero acotado.
  Un método de envío desconocido devuelve **400**.
- **Control de monto en la acreditación de pagos**: `mp-confirm` y el webhook comparan el
  `transaction_amount` de Mercado Pago contra la suma de las órdenes (± $1 de tolerancia por
  redondeo). Si no coincide, no se marca nada como pagado: `mp-confirm` responde **409** y
  ambos registran `mp_*_amount_mismatch`.
- **Ítems sin `productId` rechazados** en el checkout (**400**): sin producto identificable no hay
  precio verificable contra la base. Antes se aceptaban con el precio del body.
- **Credenciales de la BD eliminadas de la documentación**: `README.md`, `QUICKSTART.md` y
  `VERIFICATION_CHECKLIST.md` tenían el `DB_HOST` y la `DB_PASSWORD` reales en claro. ⚠️ Siguen
  en el historial de git de ambos remotos: **la password de la base debe rotarse**.
- **Documentación obsoleta eliminada**: `ARCHITECTURE.md`, `QUICKSTART.md`,
  `VERIFICATION_CHECKLIST.md` y `docs/SUPABASE_AUTH.md` describían la migración
  MongoDB → PostgreSQL y contradecían el estado real del código.
- `README.md` reescrito: entrada corta y verificada (áreas de la API, puesta en marcha, índice
  de documentación) en lugar de la guía de migración con credenciales.
- `DOCUMENTACION_BACKEND.md` §1, §2, §5, §6, §10 y §11 corregidos contra el código: la doc
  afirmaba que `authMiddleware` decodificaba el JWT sin verificar firma, que las rutas de
  usuarios eran públicas, que `login` no validaba password y que el backend no implementaba
  `/orders` ni `/shipping`. Nada de eso era cierto. Se documentaron los routers de órdenes,
  envíos, insights y el `/cloudinary/usage` faltante.
- `CLAUDE.md`: mismas correcciones sobre auth y contrato con el frontend.

### Added
- **Documentación del despliegue a producción** (`docs/flows/flow-despliegue-produccion.md`):
  cadena dominio → DNS → hosting → CORS, con diagrama, tabla de variables de entorno por
  panel, comandos de verificación y tabla de síntomas → causa → dónde se arregla.
- `.env.example` documenta que `FRONTEND_URL` acepta **varios orígenes separados por coma**
  y que en producción deben listarse todos los dominios del front. El código ya lo soportaba
  (`split(',')` en `config/cors.js`), pero el ejemplo mostraba una sola URL: quien desplegara
  a partir de él se quedaba sin CORS contra los dominios reales.
- **Analítica del asistente admin** (`/api/admin/insights/*`, solo-admin con
  `authMiddleware + adminMiddleware`, solo lectura): cinco endpoints que devuelven un
  envelope uniforme `{ success, insight }` con métricas, tabla y acción sugerida:
  - `GET /low-stock?threshold=` — productos **activos** por debajo del umbral (default 5,
    clamp 1–100). Los inactivos se excluyen: su stock bajo no es accionable para reposición.
  - `GET /sales-today` — facturación, pedidos y unidades pagadas del día (hora local AR).
  - `GET /pending-payment` — pedidos en estado `pendiente` (split MP / transferencia).
  - `GET /pending-pickups` — retiros en local por WhatsApp (`transfer` + `retiro_local`)
    pendientes de confirmar desde el momento del pedido, con antigüedad por fila.
  - `GET /top-products` — top de unidades vendidas (pagadas) del mes con facturación y
    comparación contra el mes anterior.
  - `GET /sales-growth` — productos con mayor crecimiento de unidades vs. mes anterior.
  - `GET /pickups-to-confirm` — retiros en local (`shipping_method = 'local'`) pagados,
    pendientes de confirmar la entrega (dispatch_status no entregado).
  - Capa nueva: `models/Insights.js` (queries parametrizadas) + `controllers/insightsController.js`.
- Validación server-side en `productController`: no se permite crear ni dejar un
  producto en estado `active` con stock 0 (devuelve **400**). En `create` se valida
  contra el `stock` del body; en `update` se resuelve el estado/stock objetivo contra
  la fila actual (cubre tanto activar como bajar stock a 0). Antes el controlador
  guardaba el `status` tal cual. El estado `inactive` sigue permitiendo stock 0.

### Fixed
- `package-lock.json` pasa a versionarse (estaba en `.gitignore`). Sin lockfile, cada build
  resolvía `pg: "^8.11.3"` a la última 8.x del día, así que producción instalaba algo
  distinto de lo probado en local y el deploy podía romperse sin cambios en el código.
  Con el lock presente el builder usa `npm ci` (instalación determinista); queda fijado
  `pg` 8.21.0.
- El contenedor de producción crasheaba al arrancar con `Cannot find module 'util/types'`.
  `engines.node` declaraba `>=14.0.0` y el builder resolvía el mínimo (Node 14 / npm 6),
  pero `pg` ^8.11.3 resuelve a una 8.x que requiere Node ≥16. Se fija `22.x` (misma major
  con la que se generó el `package-lock.json`) y se agrega `.nvmrc` para que el builder
  y el entorno local coincidan.
- `deleteProduct` ya no borra el asset de Cloudinary si **otro producto comparte el
  mismo `public_id`** (imagen reutilizada): antes, borrar un producto rompía la imagen
  del otro. Se consulta si algún otro producto referencia el `public_id` y, si es así,
  se saltea el borrado en Cloudinary (el producto igual se elimina de la base).
- **Módulo de órdenes** (`/api/orders/*`) que el frontend ya consumía y devolvía 404:
  - `POST /mp-preference` (auth): valida el pedido, reserva stock de forma atómica,
    registra ventas `pendiente` y crea la preferencia de Mercado Pago
    (`init_point` + `order_ids`, `external_reference` con los ids).
  - `POST /mp-confirm` (auth): verifica un pago contra la API de MP y marca las
    ventas como `pagado` (lo llama el front al volver de MP con `payment_id`).
  - `POST /mp-webhook` (público, server a server): notificaciones de pago de MP.
  - `GET /user?email=` (auth): compras pagadas del usuario; solo el dueño del
    email o un admin pueden consultarlas.
  - `POST /:id/cancel` (auth, idempotente): cancela una orden MP pendiente y
    devuelve el stock reservado.
  - `PATCH /:id/confirm-transfer` y `PATCH /:id/cancel-transfer` (admin):
    resuelven transferencias pendientes; al confirmar se descuenta stock.
- **Sweep de expiración** (cada 60 s): órdenes `pendiente` vencidas → `expirado`
  + devolución de stock (MP > 15 min, transferencias > 5 h). Ventanas alineadas
  con las que muestra el panel de Ventas del frontend.

  > **Modelo de stock (verificado contra la DB):** existe el trigger
  > `trg_decrement_stock` (AFTER INSERT en `ventas`) que descuenta stock al crear
  > cualquier venta. Por eso el backend NO descuenta stock al crear órdenes —
  > solo **valida disponibilidad** con la fila bloqueada (`SELECT … FOR UPDATE`)
  > antes de insertar, y **restaura** stock al cancelar/expirar. Si un pago se
  > acredita después de expirar, se vuelve a descontar.
- Endpoint `GET /api/shipping?postalCode=` que la página de producto ya consumía
  (devuelve `{ cost, days }` de Correo Argentino).
- Modelo `models/Order.js` (acceso a `ventas`/`productos` con transacciones) y
  cliente `utils/mercadopago.js`. Nueva variable de entorno: `MP_ACCESS_TOKEN`
  (opcional `MP_WEBHOOK_URL`); sin token, los endpoints MP responden 503 con
  mensaje claro.
- `User.findByEmail()` y `User.findByUserId()`: eran llamados por
  `loginUser` y `GET /api/users/auth/:userId` pero no existían en el modelo
  (TypeError en runtime).
- Endpoint `GET /api/cloudinary/usage`: expone el consumo de la cuenta de Cloudinary
  (recursos usados/límite) que el frontend ya consumía y devolvía 404.

### Changed
- CORS movido a `config/cors.js`. En desarrollo (`NODE_ENV !== 'production'`) se
  acepta cualquier origen local (`localhost`/`127.0.0.1` en cualquier puerto) para
  no romper cuando Vite cambia de puerto (5173 → 5174 → …). En producción se
  mantiene la allowlist estricta de `FRONTEND_URL`.
- Rutas `/api/cloudinary/*` ahora protegidas con `authMiddleware` + `adminMiddleware`
  (solo admin): `images`, `usage`, `folders` (GET/POST/DELETE), `delete`, `sign`.
  `/config` queda pública (solo expone `cloudName` + `apiKey`, datos no sensibles).
- `authMiddleware` ahora **verifica** el access token contra Supabase Auth
  (`GET /auth/v1/user`: valida firma, expiración y revocación) en lugar de solo
  decodificarlo. Requiere `SUPABASE_URL` y `SUPABASE_ANON_KEY` en el entorno.
- Rutas `/api/users/*` ahora protegidas con `authMiddleware` + `adminMiddleware`
  (solo admin): listar, ver por id, ver por auth-id, crear, actualizar, eliminar.
  Quedan públicas `signup-status`, `signup-ratelimit` y `login` (flujo pre-auth).

### Removed
- Logs de debug `[AUTH DEBUG]` en `authMiddleware` que exponían fragmentos del token.

### Fixed
- **`GET /api/cloudinary/usage` reportaba un "límite" engañoso:** `media_limit` caía
  al fallback `credits.limit` (los 25 créditos del plan free) y `media_count` era la
  cantidad de archivos, así que el front calculaba "96% del límite" comparando archivos
  contra créditos. Ahora `mapUsageResponse` devuelve el consumo real de créditos
  (`credits_used`, `credits_limit`, `credits_used_percent`) y `asset_count` como dato
  informativo aparte.
- **Checkout de Mercado Pago caía con 502 en entornos no-HTTPS (p. ej. localhost):**
  `buildPreferencePayload` enviaba siempre `auto_return: 'approved'`, pero MP
  rechaza ese campo con `400 "auto_return invalid. back_url.success must be
  defined"` cuando `back_urls.success` no es una URL pública (HTTPS) — el
  controller lo traducía a 502 y el flujo quedaba bloqueado por completo en local.
  Ahora `auto_return` solo se incluye cuando el origin del frontend es `https://`
  (producción); en HTTP/localhost se omite y la preferencia se crea igual. No
  cambia el comportamiento en producción (Vercel sirve HTTPS).
- **Las cuentas nuevas no generaban perfil:** el trigger `on_auth_user_created`
  (que crea la fila en `public.profiles`) no existía en la base, así que los
  registros nacían sin perfil (agravado al desactivar "Confirm email", porque ya
  no había un evento de confirmación posterior). Se recreó la función
  `handle_new_user` (ahora también guarda `name` desde el metadata del signup,
  con `ON CONFLICT DO NOTHING`) y el trigger `AFTER INSERT ON auth.users`. En
  `initDatabase.js` se aplican siempre (idempotente) para evitar drift repo↔base.
  Se backfillearon los perfiles faltantes de cuentas ya existentes.
- **Borrado de usuario dejaba la cuenta de auth viva:** `User.findByIdAndDelete`
  solo garantizaba el borrado del perfil; si el perfil ya no existía no llegaba a
  borrar `auth.users`, dejando el email "ocupado" (el signup fallaba con "ya
  registrado"). Ahora borra `auth.users` (fuente de verdad) y el perfil de forma
  defensiva, y funciona aunque el perfil ya no exista.
- **Panel de usuarios ocultaba cuentas sin perfil:** `User.findAll` listaba
  `FROM profiles`, por lo que una cuenta de `auth.users` sin perfil quedaba
  invisible e ingestionable desde el panel. Ahora lista `FROM auth.users` (LEFT
  JOIN a `profiles`) para mostrarlas y poder eliminarlas.
- `req.user` ahora incluye `email` (verificado por Supabase): lo usan las rutas
  de órdenes para validar que un usuario solo vea/cancele sus propias compras.
- `server.js` loguea promesas rechazadas sin manejar (`unhandledRejection`).
- `GET /api/cloudinary/images` ya no enmascara errores de Cloudinary como `200/success`:
  si Cloudinary responde con `{ error }` o sin `resources`, se propaga `502` para que
  el frontend muestre estado de error en vez de crashear.

### Security
- **Bypass de login cerrado:** `POST /api/users/login` devolvía éxito con cualquier
  contraseña si el email existía (la comparación estaba comentada). Ahora valida
  las credenciales contra Supabase Auth (`grant_type=password`) y la ruta quedó
  registrada en `userRoutes`.
- `.env.example` tenía la contraseña real de la base de datos commiteada; se
  reemplazó por un placeholder. **Rotar esa contraseña en Supabase** si el repo
  se compartió.
- Cierre de acceso anónimo a listado/borrado/firma de Cloudinary: antes cualquiera con
  la URL podía listar o borrar imágenes y generar firmas de upload.
- **Auth bypass cerrado:** `authMiddleware` validaba el JWT con `jwt.decode` (sin verificar
  firma), por lo que un token falsificado con `sub`/rol de admin pasaba. Ahora la firma se
  verifica contra Supabase; un token forjado responde `401`.
- `.gitignore` cubría `.env`, `.env.local` y `.env.*.local`, pero **no** `.env.production`
  ni `.env.staging`: un archivo con credenciales de producción se podía commitear sin que
  git lo frenara. Se reemplazó por `.env.*` con excepción explícita `!.env.example`, de modo
  que cualquier variante futura queda ignorada por defecto. Se agregaron además `.claude/`,
  `.playwright-mcp/` y capturas de pantalla (`*.png`, `*.jpg`, `*.jpeg`, `*.webp`), que el
  repo raíz ya ignoraba y este no. Verificado con `git check-ignore`; no había ningún
  secreto trackeado.

---

## 🎯 Visión General

Se ha completado una migración integral del proyecto `lia-ecommerce` de **MongoDB Atlas** a **PostgreSQL en Supabase**, manteniendo toda la lógica de negocio intacta.

---

## 📦 Cambios de Dependencias

### ➖ Removidas
| Paquete | Versión | Razón |
|---------|---------|-------|
| `mongoose` | ^8.0.0 | ODM específico para MongoDB |

### ➕ Añadidas
| Paquete | Versión | Propósito |
|---------|---------|----------|
| `pg` | ^8.11.3 | Cliente nativo de PostgreSQL |

### ℹ️ Sin cambios (actualizadas versiones menores)
- `bcryptjs`, `cors`, `dotenv`, `express`, `nodemon`

**Archivo**: [package.json](package.json#L1)

---

## 📂 Estructura de Archivos

### Archivos Creados (Nuevos)

```
📁 config/
   ├── initDatabase.js      ✨ Inicializa tablas PostgreSQL
   └── migrateData.js       ✨ Script para migrar datos de MongoDB
   
📁 middleware/
   └── authMiddleware.js    ✨ Middlewares de autenticación
   
📁 docs/
   └── SUPABASE_AUTH.md     ✨ Guía de integración con Supabase Auth

📄 .env.example            ✨ Plantilla de variables de entorno
📄 .gitignore              ✨ Archivos a ignorar en Git
📄 README.md               ✨ Documentación actualizada (actualizado)
📄 CHANGELOG.md            ✨ Este archivo
```

### Archivos Modificados

| Archivo | Cambios |
|---------|---------|
| [package.json](package.json) | Actualizado: dependencias, nombre, descripción, scripts |
| [server.js](server.js) | Actualizado: importes, middleware, manejo de errores |
| [config/database.js](config/database.js) | Reescrito: conexión PostgreSQL con pool de pg |
| [models/User.js](models/User.js) | Reescrito: de esquema Mongoose a clase con métodos SQL |
| [controllers/userController.js](controllers/userController.js) | Reescrito: de Mongoose queries a SQL directo |
| [routes/userRoutes.js](routes/userRoutes.js) | Actualizado: nueva ruta GET /api/users/auth/:userId |
| [.env](.env) | Actualizado: variables PostgreSQL/Supabase |

---

## 🔄 Cambios Detallados por Archivo

### 1. **package.json**
**Antes:**
```json
{
  "name": "mvc-node-mongodb",
  "dependencies": {
    "mongoose": "^8.0.0"
  }
}
```

**Después:**
```json
{
  "name": "lia-ecommerce",
  "dependencies": {
    "pg": "^8.11.3"
  },
  "scripts": {
    "init-db": "node config/initDatabase.js"
  }
}
```

### 2. **config/database.js**
**Antes:** 15 líneas con conexión Mongoose a MongoDB Atlas
**Después:** 31 líneas con Pool de PostgreSQL y SSL para Supabase

**Cambios clave:**
- ❌ Elimina: `mongoose.connect()`
- ✅ Añade: `Pool` de `pg` con configuración Supabase
- ✅ Añade: Manejo de errores de conexión

### 3. **models/User.js**
**Transformación completa**: De esquema Mongoose a clase con métodos estáticos

| Método | Antes | Después |
|--------|-------|---------|
| `findOne()` | Mongoose | `findByEmail()` o `findById()` |
| `find()` | Mongoose | `findAll(limit, offset)` |
| `findById()` | Mongoose | Reescrito con SQL |
| `create()` | Mongoose | SQL INSERT con validaciones |
| `findByIdAndUpdate()` | Mongoose | Transacción SQL UPDATE |
| `findByIdAndDelete()` | Mongoose | SQL DELETE con verificación |
| ➕ `findByUserId()` | N/A | **Nuevo** para Supabase Auth |

**Nueva estructura de tabla:**
```sql
profiles (
  id UUID,
  user_id UUID,        -- Referencia a auth.users de Supabase
  name VARCHAR(100),
  email VARCHAR(255),
  role VARCHAR(20),
  created_at, updated_at TIMESTAMP
)
```

### 4. **controllers/userController.js**
**Cambios principales:**

| Endpoint | Cambios |
|----------|---------|
| POST /login | Preparado para Supabase Auth |
| GET / | Añade paginación (limit, offset) |
| GET /:id | Búsqueda por UUID en lugar de ObjectId |
| POST / | Usa `User.create()` con transacciones |
| PUT /:id | Actualización parcial con validaciones |
| DELETE /:id | Soft delete compatible |
| ➕ GET /auth/:userId | **Nuevo** endpoint para Supabase User ID |

### 5. **routes/userRoutes.js**
```javascript
// Antes (Mongoose)
router.get('/:id', getUserById);

// Después (SQL + Nueva ruta)
router.get('/:id', getUserById);              // UUID
router.get('/auth/:userId', getUserByAuthId); // Supabase Auth ID
```

### 6. **server.js**
**Cambios estructurales:**
- ❌ Elimina: `require('mongoose')`
- ✅ Actualiza: Destructuring de `connectDB`
- ✅ Añade: Ruta `/health` para monitores
- ✅ Mejora: Manejo global de errores
- ✅ Mejora: Logs más informativos

### 7. **.env**
**Antes:**
```env
MONGODB_URI=mongodb+srv://user:pwd@cluster.mongodb.net/db
PORT=3000
```

**Después:**
```env
DB_HOST=db.nakhbsncabvwyrezhfsf.supabase.co
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=***
DB_NAME=postgres
PORT=3000
```

---

## 🗄️ Cambios en Base de Datos

### Nueva Tabla: `profiles`
```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  role VARCHAR(20) NOT NULL DEFAULT 'user' 
    CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Índices Creados
- `idx_profiles_email` - Búsqueda rápida por email
- `idx_profiles_user_id` - Búsqueda rápida por user_id

### Triggers Automáticos
- Función: `update_updated_at_column()` - Actualiza `updated_at` automáticamente

---

## 🔄 Mapeo de Operaciones

### Consultas de Usuario

| Operación | MongoDB | PostgreSQL |
|-----------|---------|-----------|
| Crear usuario | `User.create({...})` | `pool.query('INSERT INTO...')` |
| Buscar por email | `User.findOne({email})` | `pool.query('SELECT * WHERE email')` |
| Buscar por ID | `User.findById(id)` | `pool.query('SELECT * WHERE id')` |
| Listar todos | `User.find()` | `pool.query('SELECT * LIMIT... OFFSET...')` |
| Actualizar | `User.findByIdAndUpdate()` | `pool.query('UPDATE SET...')` |
| Eliminar | `User.findByIdAndDelete()` | `pool.query('DELETE WHERE id')` |

---

## 🔐 Cambios en Autenticación

### Sistema de Roles
✅ Se mantiene igual: `'user'` y `'admin'`

### Integración Supabase
- ➕ **Nuevo campo** `user_id` UUID para vincular con `auth.users` de Supabase
- ➕ **Nuevo método** `findByUserId()` para buscar por Supabase User ID
- 📝 **Documentación** en `docs/SUPABASE_AUTH.md` con ejemplos

---

## 📊 Resumen de Líneas de Código

| Archivo | Antes | Después | Cambio |
|---------|-------|---------|--------|
| package.json | 23 | 24 | +1 |
| server.js | 34 | 60 | +26 |
| config/database.js | 15 | 31 | +16 |
| models/User.js | 34 | 250+ | Reescrito |
| controllers/userController.js | 140 | 270+ | Reescrito |
| routes/userRoutes.js | 17 | 20 | +3 |
| **TOTAL** | **~263** | **~655** | **+392** |

---

## ✅ Checklist de Migración

- [x] Actualizar dependencias en package.json
- [x] Reescribir config/database.js para PostgreSQL
- [x] Crear script de inicialización de tablas
- [x] Migrar esquema User a tabla SQL
- [x] Reescribir controlador de usuarios
- [x] Actualizar rutas
- [x] Configurar variables de entorno
- [x] Crear documentación de Supabase Auth
- [x] Script de migración de datos
- [x] Middleware de autenticación
- [x] .gitignore actualizado
- [x] README.md actualizado

---

## 🚀 Próximos Pasos

1. **Instalar dependencias:**
   ```bash
   npm install
   ```

2. **Inicializar la base de datos:**
   ```bash
   npm run init-db
   ```

3. **Iniciar servidor:**
   ```bash
   npm run dev
   ```

4. **(Opcional) Migrar datos existentes:**
   ```bash
   npm node config/migrateData.js
   ```

---

## 📚 Documentación

- **Configuración**: Ver [README.md](README.md)
- **Autenticación Supabase**: Ver [docs/SUPABASE_AUTH.md](docs/SUPABASE_AUTH.md)
- **Variables de entorno**: Ver [.env.example](.env.example)

---

## 🔗 URL de Conexión

| Parámetro | Valor |
|-----------|-------|
| Host | `db.nakhbsncabvwyrezhfsf.supabase.co` |
| Puerto | `5432` |
| Usuario | `postgres` |
| Base de datos | `postgres` |
| SSL | Requerido |

---

## 💡 Notas Importantes

1. **MongoDB Object ID vs PostgreSQL UUID**
   - Todos los IDs ahora son UUIDs (128 bits)
   - Las búsquedas funcionan igual pero con formato diferente

2. **Contraseñas y Autenticación**
   - Supabase Auth maneja las contraseñas de forma más segura
   - La tabla `profiles` no almacena contraseñas (solo metadatos)

3. **Transacciones**
   - Implementadas en operaciones críticas (create, update, delete)
   - Mayor integridad de datos

4. **Rendimiento**
   - Índices optimizados para consultas frecuentes
   - Paginación en listados

---

## 📞 Soporte

Si encuentras problemas:

1. Verifica las credenciales de Supabase en `.env`
2. Ejecuta `npm run init-db` para recrear tablas
3. Revisa logs del servidor: `console.error()`
4. Consulta [docs/SUPABASE_AUTH.md](docs/SUPABASE_AUTH.md)

---

**Versión**: 1.0.0  
**Fecha de Migración**: Marzo 2026  
**Estado**: ✅ Completado
