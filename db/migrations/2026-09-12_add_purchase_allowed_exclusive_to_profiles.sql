-- ============================================================================
-- Modo de compra restringida (allowlist de compradores) — 2026-09-12
--
-- CONTEXTO
-- Feature de mantenimiento para producción: el admin puede marcar a uno o
-- varios usuarios como "comprador habilitado". Mientras exista al menos un
-- usuario marcado, el sistema entra en "modo restringido": solo esos usuarios
-- pueden completar una compra; el resto ve un aviso de sitio en mantenimiento.
-- Si el admin desmarca al último usuario, el modo restringido se desactiva
-- solo y la compra vuelve a estar habilitada para todos.
--
-- No hay un switch global aparte: el modo restringido se deriva de si existe
-- al menos una fila con purchase_allowed_exclusive = true (ver
-- User.getPurchasePermission en models/User.js).
--
-- QUÉ NO ROMPE
--  - Columna nueva con DEFAULT false: ningún perfil existente cambia de
--    comportamiento (todos siguen pudiendo comprar normalmente).
--  - No toca RLS: el backend escribe como `postgres` (dueño de la tabla) y
--    la única policy de SELECT existente (profiles_select_self_or_admin) ya
--    cubre esta columna al ser un SELECT *.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS purchase_allowed_exclusive boolean NOT NULL DEFAULT false;

-- Índice parcial: la comprobación de "¿hay modo restringido activo?" corre en
-- cada intento de compra (EXISTS contra esta columna), así que conviene que
-- sea barata incluso con la tabla profiles grande.
CREATE INDEX IF NOT EXISTS idx_profiles_purchase_allowed_exclusive
  ON public.profiles (id)
  WHERE purchase_allowed_exclusive = true;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (ejecutar después)
-- ============================================================================
-- SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'profiles'
--    AND column_name = 'purchase_allowed_exclusive';
--
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE tablename = 'profiles' AND indexname = 'idx_profiles_purchase_allowed_exclusive';

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- DROP INDEX IF EXISTS public.idx_profiles_purchase_allowed_exclusive;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS purchase_allowed_exclusive;
