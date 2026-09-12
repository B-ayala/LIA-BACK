-- ============================================================================
-- Admin principal (owner) intransferible por accidente — 2026-09-12
--
-- CONTEXTO
-- Bug reportado: en el panel de Usuarios, al usuario admin equivocado (uno
-- recién promovido) le quedaba bloqueado el botón para sacarle el rol, y al
-- admin "principal" (la cuenta original de la tienda) SÍ se le podía sacar
-- el admin — exactamente al revés de lo esperado. El único chequeo que
-- existía (`isSelf`) protege "no te saques el rol a vos mismo", no protege
-- una cuenta principal designada.
--
-- Se agrega el concepto de "owner": exactamente un perfil puede tener
-- is_owner = true. A ese usuario no se le puede quitar el rol admin ni
-- eliminarlo (validado en el backend, ver models/User.js). Se transfiere
-- manualmente (feature futura); por ahora se asigna una sola vez acá al
-- admin más antiguo existente, para no dejar el sitio sin owner.
--
-- QUÉ NO ROMPE
--  - Columna nueva con DEFAULT false: ningún perfil existente cambia de
--    comportamiento salvo el que se marca explícitamente como owner abajo.
--  - No toca RLS: mismo criterio que la migración de purchase_allowed_exclusive.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;

-- A lo sumo un owner en todo el sistema.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_single_owner
  ON public.profiles ((is_owner))
  WHERE is_owner = true;

-- Asignar el owner inicial: el admin más antiguo. Si ya hay un owner
-- (re-ejecución de la migración), no hace nada.
UPDATE public.profiles
SET is_owner = true
WHERE id = (
  SELECT id FROM public.profiles
  WHERE role = 'admin'
  ORDER BY created_at ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE is_owner = true);

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (ejecutar después)
-- ============================================================================
-- SELECT id, name, role, is_owner, created_at FROM public.profiles WHERE is_owner = true;
-- (debe devolver exactamente una fila)

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- DROP INDEX IF EXISTS public.idx_profiles_single_owner;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS is_owner;
