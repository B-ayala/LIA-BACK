-- ============================================================================
-- Idempotencia persistente de la creación de órdenes — 2026-10-08
--
-- CONTEXTO
-- `POST /api/orders/mp-preference` y `/transfer` aceptan el header
-- `Idempotency-Key`. Hasta ahora la respuesta exitosa se recordaba solo en
-- memoria del proceso: si Render reiniciaba o dormía el servicio, un reintento
-- tardío con la misma key creaba otro juego de ventas (y descontaba stock de
-- nuevo). Esta tabla persiste el resultado para que sobreviva a reinicios.
--
-- QUÉ NO ROMPE
--  - Tabla nueva: ninguna tabla ni query existente cambia.
--  - Si esta migración NO está aplicada, el backend sigue funcionando: la
--    idempotencia cae a memoria (con un warn en logs) y el checkout no se corta.
--  - Solo el backend (conexión directa a la base) la usa: RLS activo sin
--    policies y sin permisos para anon/authenticated, así nadie la lee ni la
--    escribe desde el navegador (guarda init_point de pagos).
--
-- RETENCIÓN
--  Una respuesta solo se reutiliza durante 10 min; el sweep de órdenes del
--  backend borra las filas de más de 1 día.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
--
-- ROLLBACK
--  DROP TABLE public.idempotency_keys;  (el backend vuelve a idempotencia en memoria)
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  scope        text        NOT NULL,
  key          text        NOT NULL,
  fingerprint  text        NOT NULL,
  status       smallint    NOT NULL,
  body         jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
  ON public.idempotency_keys (created_at);

ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.idempotency_keys FROM anon, authenticated;

COMMIT;
