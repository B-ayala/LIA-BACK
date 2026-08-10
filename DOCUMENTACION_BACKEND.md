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
│   └── 2026-08-08_add_performance_indexes.sql   # índices de las consultas calientes
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
│   ├── orderController.js      # reserva de stock, preferencia MP, transferencias, nudge, sweep
│   ├── insightsController.js   # analítica del asistente admin (cacheada 60 s)
│   ├── shippingController.js   # cotización por código postal
│   └── cloudinaryController.js # firma SHA1, delete, getImages, getConfig, folders
│
├── models/                    # Acceso a datos (SQL parametrizado)
│   ├── User.js                # profiles
│   ├── Order.js               # ventas + stock (FOR UPDATE, expiración, pago tardío)
│   └── Insights.js            # agregaciones de analítica
│
├── middleware/
│   ├── authMiddleware.js       # verifica el token contra Supabase (con caché corta) + adminMiddleware
│   ├── rateLimit.js            # límites por endpoint (ventana deslizante) con headers estándar
│   ├── concurrencyLimit.js     # bulkhead + cola con timeout → 503 en vez de colapso
│   ├── httpCache.js            # Cache-Control público / no-store
│   ├── securityHeaders.js      # CSP/HSTS/nosniff/X-Frame-Options en toda respuesta
│   └── signupTracker.js        # rate-limit de signup in-memory (Map por email)
│
├── utils/
│   ├── cache.js               # caché TTL + single-flight (coalescing) e invalidación del catálogo
│   ├── logger.js              # logs estructurados JSON, nivelados por LOG_LEVEL
│   └── mercadopago.js         # cliente de la API de Mercado Pago
│
├── qa/
│   ├── test-plan.md           # plan de pruebas (incluye TC-180–TC-193 de concurrencia y carga)
│   └── load-test.js           # suite de carga y concurrencia sin dependencias
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
controllers/*      → validación de input, orquestación, forma de la respuesta { success, data, ... }
   │
   ▼
models/User.js  ó  pool.query(...)   → acceso a PostgreSQL/Supabase
   │
   ▼
config/database.js → Pool de conexiones pg
```

- **Separación de capas**: routes → controllers → (models | pool). Los controllers no definen
  rutas; los models encapsulan SQL de `profiles`. **Excepción**: `productController` y
  `cloudinaryController` ejecutan `pool.query` / llamadas HTTP directamente (no usan una capa
  model dedicada).
- **Respuesta consistente**: todas las respuestas siguen `{ success: boolean, ... }`
  (`data`, `message`, `count/total/limit/offset` en listados).
- **Arranque ordenado** (`server.js`): primero `connectDB()` (con reintentos), recién entonces
  `app.listen`. Si la BD no conecta, el proceso sale con código 1.

---

## 5. Endpoints

### 5.1 Usuarios — `/api/users` (`userRoutes.js` → `userController.js`)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| GET | `/api/users/signup-status/:email` | pública | Estado de rate-limit de signup (solo lectura). |
| POST | `/api/users/signup-ratelimit` | pública | Registra que Supabase devolvió rate-limit para un email. Body `{ email }`. |
| POST | `/api/users/login` | pública | Valida credenciales contra Supabase Auth (`/auth/v1/token?grant_type=password`) y devuelve el perfil. Rate limit 10/min. |
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
| GET | `/api/products` | pública | Lista paginada (`?limit&offset`, máx 100), `ORDER BY created_at DESC`. |
| GET | `/api/products/:id` | pública | Producto por id. |
| POST | `/api/products` | **Bearer + admin** | Crea producto. Requiere `name` y `price`. |
| PUT | `/api/products/:id` | **Bearer + admin** | Update dinámico (solo campos presentes). |
| DELETE | `/api/products/:id` | **Bearer + admin** | Borra producto y su imagen en Cloudinary (best-effort). |

Body de create/update (camelCase → columnas snake_case): `name`, `price`, `stock`, `category`,
`imageUrl`/`images[]` (se sincroniza `image_url` con la primera), `publicId`, `description`,
`discount` (admite null), `condition` (`new`/`used`), `freeShipping`, `variants`,
`specifications`, `features`, `faqs` (JSONB), `warranty`, `returnPolicy`, `status`.

### 5.3 Órdenes y pagos — `/api/orders` (`orderRoutes.js` → `orderController.js`)
| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| POST | `/api/orders/mp-webhook` | pública (server a server) | Notificación de Mercado Pago; verifica el pago contra la API de MP y marca las ventas. Rate limit 240/min. |
| POST | `/api/orders/transfer` | **Bearer** | Crea la orden por transferencia bancaria (el trigger de la BD descuenta stock). |
| POST | `/api/orders/mp-preference` | **Bearer** | Valida stock con `SELECT … FOR UPDATE`, inserta ventas `pendiente` y crea la preferencia MP (`init_point`, `order_ids`). **409** si no hay stock; **503** sin `MP_ACCESS_TOKEN`. |
| POST | `/api/orders/mp-confirm` | **Bearer** | Confirma el pago verificándolo contra la API de MP (no confía en la URL de retorno) y **compara el monto acreditado** con el total de las órdenes: si no coincide, **409**. |
| GET | `/api/orders/user?email=` | **Bearer** | Órdenes del usuario. Solo el dueño o un admin (ajeno → **403**). |
| POST | `/api/orders/nudge` | **Bearer** | Registra el recordatorio de pago pendiente. |
| POST | `/api/orders/:id/cancel` | **Bearer** | Cancela una orden propia y restaura stock (ajena → **403**). |
| PATCH | `/api/orders/:id/confirm-transfer` | **Bearer + admin** | Confirma la transferencia → `pagado` (no re-descuenta stock). Ya resuelta → **409**. |
| PATCH | `/api/orders/:id/cancel-transfer` | **Bearer + admin** | Cancela la transferencia → `cancelado` + stock restaurado. |

**El importe lo decide el servidor.** `reserveOrders` lee `price`/`discount`/`original_price` en el
mismo `SELECT … FOR UPDATE` que bloquea el stock y recalcula `unit_price`/`total_price`; el
`unitPrice` del body se ignora. La regla replica `getProductPricing` del frontend
(`src/utils/pricing.ts`): **si cambia una, hay que cambiar la otra**. El costo de envío se valida
contra la tarifa de `shippingController` (`local` 0, `correo` `CORREO_COST`, `moto` variable
acotado). Un ítem sin `productId` se rechaza con 400: sin producto no hay precio verificable.

Rate limits: checkout 12/min (`transfer`, `mp-preference`), mutaciones 40/min. Todo `no-store`.
Además, `server.js` corre `expireStaleOrders` cada 60 s: expira pendientes vencidas (MP 15 min,
transferencia 5 h) y restaura stock. Detalle del flujo en `docs/flows/flow-checkout.md`.

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
| GET | `/health` | Health check (`{ status: 'OK' }`). |
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
  single-flight para no disparar N verificaciones del mismo token en paralelo. Solo se cachean
  verificaciones exitosas. **Trade-off explícito**: un token revocado puede seguir siendo
  aceptado hasta que expire el TTL.
- **`adminMiddleware`**: debe ir después de `authMiddleware`; exige `req.user.role === 'admin'`
  (403 si no).
- **Cobertura**: la cadena protege las escrituras de productos, **todo** el router de usuarios
  salvo login/signup-status/signup-ratelimit, órdenes (salvo el webhook de MP), la analítica
  admin completa y Cloudinary salvo `/config`.

---

## 7. Modelo de datos (PostgreSQL / Supabase)

Acceso directo con `pg` al Postgres de Supabase (esquemas `public` y `auth`).

| Tabla | Esquema | Uso en el backend |
|---|---|---|
| `profiles` | public | `id UUID` (FK → `auth.users.id`, ON DELETE CASCADE), `name`, `role` (`user`/`admin`), `created_at`. RLS habilitada; política "Users see their profile". Índice `idx_profiles_role`. |
| `auth.users` | auth | gestionada por Supabase Auth; se lee (`email`, `email_confirmed_at`) y se borra en cascada al eliminar perfil. |
| `productos` | public | CRUD vía `productController`. Columnas (incluidas por `init-db`): `name`, `price`, `stock`, `category`, `image_url`, `public_id`, `description`, `discount NUMERIC(5,2)`, `condition`, `free_shipping`, `variants/specifications/features/faqs/images JSONB`, `warranty`, `return_policy`, `status`, `featured`, `created_at`, `updated_at`. |
| `carousel_images` | public | creada por `init-db` (`id`, `url`, `order`, `is_active`, `created_at`). La escribe el frontend directo; el backend solo la crea. |

**Trigger** (`init-db`): `on_auth_user_created` → `handle_new_user()` inserta una fila en
`profiles` (rol `user`) cada vez que se crea un usuario en `auth.users`.

> El esquema "fuente de verdad" lo administra Supabase; `init-db` es idempotente
> (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) y sirve para alinear una BD nueva.

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
| `MP_WEBHOOK_SECRET` | — (recomendada en prod) | **Secreto.** Firma del webhook (panel MP → Webhooks). Si está, se valida `x-signature` y se rechaza con **401** lo que no cuadre; si falta, el webhook igual revalida cada pago contra la API de MP. |

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
| `MAX_CONCURRENT_REQUESTS` | `DB_POOL_MAX × 2` | Handlers simultáneos admitidos (bulkhead). |
| `MAX_QUEUED_REQUESTS` | `200` | Cola de espera; al llenarse se responde **503 + `Retry-After`**. |
| `QUEUE_TIMEOUT_MS` | `8000` | Espera máxima en cola antes de devolver 503. |
| `CACHE_TTL_PRODUCTS_SECONDS` | `20` | Caché del catálogo. `0` la desactiva. Se invalida sola ante cambios de producto/stock. |
| `CACHE_TTL_INSIGHTS_SECONDS` | `60` | Caché de la analítica admin. |
| `CACHE_TTL_AUTH_SECONDS` | `30` | Caché de verificación de token. ⚠️ Un token revocado sigue siendo válido como máximo este tiempo. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

`GET /health` expone en vivo el estado del pool, del bulkhead, del rate limit y de las cachés.

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
  más estricto en login (10/min) y checkout (12/min).
- **Logs estructurados** (`utils/logger.js`) sin tokens ni PII; la caché de auth indexa por
  SHA-256 del token.
- **SQL parametrizado** en todas las queries; transacciones y `FOR UPDATE` en el stock.
- **Precio e importe decididos por el servidor** en el checkout, y monto del pago contrastado
  contra el total de las órdenes antes de marcarlas pagadas (ver §5.3).
- **CORS con allowlist** por `FRONTEND_URL` (nunca `*` en producción).

- **Headers de seguridad** en toda respuesta (`middleware/securityHeaders.js`): CSP restrictiva,
  `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, CORP y HSTS cuando se sirve por HTTPS.
- **Firma del webhook de MP** verificada con HMAC-SHA256 y comparación en tiempo constante
  cuando `MP_WEBHOOK_SECRET` está configurada.
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

---

## 11. Contrato con el frontend

El frontend (`../../FRONT/damiana-bella`, repo propio) y este backend están **alineados**:

- **Auth**: la maneja **Supabase Auth desde el front** (`signInWithPassword`, `signUp`,
  `verifyOtp`, `resetPasswordForEmail`). No hay endpoints `/api/auth/*` acá y **no hacen falta**:
  el backend solo verifica el access token que el front adjunta.
- **Órdenes, envíos, insights y Cloudinary**: implementados (§5.3 a §5.6) y consumidos por
  `src/services/orderService.ts`, `shippingService`, `insightsService` y `productService`.
- **Transferencias**: el front **no** inserta en `ventas` directo por Supabase (lo bloqueaba RLS);
  usa `POST /api/orders/transfer`, que corre con el pool del backend.

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
