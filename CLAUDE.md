# CLAUDE.md — Backend (lia-store / "lia-ecommerce")

> Archivo de configuración de Claude Code para **este repositorio (backend)**.
> Carga automáticamente el sistema de skills senior compartido y deja disponible
> la documentación técnica del proyecto.

---

## 🎯 Contexto del proyecto

Este repo es el **backend** de la tienda **damiana-bella**: una **API REST en Node.js + Express**
con patrón **MVC**, sobre **PostgreSQL/Supabase** (acceso directo con `pg`). Expone:

- `/api/users` — perfiles (`public.profiles` + `auth.users`), login contra Supabase Auth, rate-limit de signup.
- `/api/products` — CRUD de productos (lectura pública cacheada, escritura admin).
- `/api/orders` — checkout: Mercado Pago, transferencias, cancelaciones, webhook, expiración de pendientes.
- `/api/shipping` — cotización de envío por código postal.
- `/api/admin/insights` — analítica del asistente admin (solo admin).
- `/api/cloudinary` — firma de uploads y gestión de imágenes/carpetas.

Entry point: `server.js`. Scripts: `npm run dev` (nodemon), `npm start`, `npm run init-db`.

📄 Documentación técnica completa (estructura, arquitectura MVC, endpoints, modelo de datos,
configuración, cómo levantar y estado de seguridad) en
[DOCUMENTACION_BACKEND.md](DOCUMENTACION_BACKEND.md). **Leela antes de tocar código.**

El frontend (`../../FRONT/damiana-bella`, repo propio) está **alineado** con estos contratos:
maneja la sesión con Supabase Auth y adjunta el access token, que acá se verifica contra
Supabase. Ver §11 de la documentación antes de modificar cualquier contrato.

---

## 🧠 Skills senior compartidos (carga automática)

Los siguientes skills viven en `../../skill/` (carpeta compartida entre frontend y backend)
y se importan automáticamente. Aplican como contrato de calidad para todo lo que se genere
en este repo.

@../../skill/00-role.md
@../../skill/01-backend.md
@../../skill/03-testing-qa.md
@../../skill/04-security.md
@../../skill/06-restrictions.md
@../../skill/07-senior-rules.md
@../../skill/08-delivery-format.md
@../../skill/09-protocols.md
@../../skill/10-documentation.md
@../../skill/11-bug-hunter.md
@../../skill/12-judge-architect.md

> Selección backend según `../../skill/README.md` (00 + 01 + 03 + 04 + 06 + 07 + 08 + 09 + 10),
> más bug-hunter (11) y judge-architect (12). Se omiten `02-frontend.md` y `05-ux.md`
> (viven en el repo frontend).
>
> **Nota de portabilidad:** las rutas `@../../skill/*` resuelven a `…/orden damiana/skill`.
> Si clonás este repo fuera de esa estructura de carpetas, ajustá las rutas o copiá la carpeta
> `skill/` al nuevo emplazamiento.

---

## ⚠️ Reglas específicas de este repo

- **Secretos solo en `.env`** (DB, Cloudinary, Supabase, Mercado Pago). `.env.example` lleva
  únicamente placeholders: nunca pegar valores reales en un archivo versionado.
- **Deuda abierta**: el historial de git de ambos remotos todavía contiene la password de la BD
  que estuvo commiteada en docs viejas. **Hay que rotarla** (ver §10 de la documentación).
- **Auth**: `authMiddleware` verifica el access token contra Supabase Auth y cachea el resultado
  30 s. No relajar esa verificación ni ampliar el TTL sin pensarlo dos veces.

### 📄 Mantenimiento de la documentación

- **El código es la fuente de verdad.** Si `DOCUMENTACION_BACKEND.md`, `README.md` o este archivo
  contradicen al código, el error está en la doc: verificá contra el código y corregila.
- **Docs de estado → se corrigen, no se acumulan.** `DOCUMENTACION_BACKEND.md`, `README.md`,
  `CLAUDE.md` y `docs/flows/` describen cómo es el sistema **hoy**: si un cambio invalida un
  párrafo, se reescribe ese párrafo en el mismo cambio. Agregar una sección nueva dejando la vieja
  produce docs que se contradicen entre sí.
- **Solo `CHANGELOG.md` acumula** (append-only): es historia, no estado. `qa/test-plan.md` acumula
  casos, pero los resultados se actualizan.
- Alcance mínimo: tocar la sección afectada. No hace falta releer la doc entera en cada cambio.
- No mezclar lógica de frontend en este repo. Mantener la documentación separada de la del front.
