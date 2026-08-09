# LIA Store — Backend

API REST en **Node.js + Express** (MVC) sobre **PostgreSQL/Supabase**, acceso directo con `pg`.
Es el backend de la tienda **damiana-bella**; el frontend vive en otro repo
([LIA-FRONT](https://github.com/B-ayala/LIA-FRONT)).

## Áreas de la API (prefijo `/api`)

| Router | Qué resuelve |
|---|---|
| `/api/users` | Perfiles (`public.profiles` + `auth.users`), login contra Supabase Auth, rate-limit de signup. |
| `/api/products` | Catálogo (lectura pública cacheada) y CRUD de admin. |
| `/api/orders` | Checkout: preferencia de Mercado Pago, transferencias, cancelaciones, webhook y expiración de pendientes. |
| `/api/shipping` | Cotización de envío por código postal. |
| `/api/admin/insights` | Analítica del asistente del panel admin (solo admin). |
| `/api/cloudinary` | Firma de uploads y gestión de imágenes/carpetas. |

Entry point: `server.js`. Health check: `GET /health`.

## Puesta en marcha

Requiere **Node 22.x**.

```bash
npm install
cp .env.example .env    # completar con credenciales propias
npm run init-db         # solo en una base nueva (idempotente)
npm run dev             # nodemon → http://localhost:3000
```

Variables de entorno: ver `.env.example`. **Nunca** commitear el `.env` ni valores reales
en este README.

## Documentación

| Documento | Contenido |
|---|---|
| [DOCUMENTACION_BACKEND.md](DOCUMENTACION_BACKEND.md) | Referencia técnica completa: estructura, capas, endpoints, modelo de datos, configuración, cómo levantar y troubleshooting. **Empezá por acá.** |
| [docs/flows/](docs/flows/) | Flujos de negocio en mermaid: checkout, asistente admin, concurrencia y carga, despliegue a producción. |
| [qa/test-plan.md](qa/test-plan.md) | Plan de pruebas con casos y resultados. |
| [CHANGELOG.md](CHANGELOG.md) | Historial de cambios (Keep a Changelog + SemVer). |
