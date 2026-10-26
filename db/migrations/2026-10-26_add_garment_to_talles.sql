-- ============================================================================
-- Prenda en el catálogo de talles — 2026-10-26  (PENDIENTE de aplicar)
--
-- CONTEXTO
-- Una "M" de camisa no mide lo mismo que una "M" de saco. Se agrega `garment`
-- (prenda), texto opcional, y la unicidad pasa de (type, nombre) a
-- (type, prenda, nombre), sin distinguir mayúsculas. Requiere haber aplicado
-- antes 2026-10-26_create_talles_catalog.sql.
--
-- CÓMO APLICAR
--  Supabase -> SQL Editor -> pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

ALTER TABLE public.talles ADD COLUMN IF NOT EXISTS garment text NULL;

ALTER TABLE public.talles DROP CONSTRAINT IF EXISTS talles_garment_check;
ALTER TABLE public.talles ADD CONSTRAINT talles_garment_check
  CHECK (garment IS NULL OR (char_length(btrim(garment)) BETWEEN 1 AND 30 AND garment = btrim(garment)));

DROP INDEX IF EXISTS public.talles_type_lower_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS talles_type_garment_lower_name_key
  ON public.talles (type, lower(coalesce(garment, '')), lower(name));

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT column_name, is_nullable FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'talles' AND column_name = 'garment';
-- SELECT indexname FROM pg_indexes
--  WHERE schemaname = 'public' AND tablename = 'talles';
--   -- debe estar talles_type_garment_lower_name_key y NO talles_type_lower_name_key
-- POST /api/sizes "M" indumentaria con prenda "Camisa" y luego con "Saco": ambos
-- 201. Repetir "m" con "camisa": 409 SIZE_DUPLICATE.

-- ============================================================================
-- ROLLBACK (solo si no hay talles con el mismo nombre en distintas prendas)
-- ============================================================================
-- BEGIN;
--   DROP INDEX IF EXISTS public.talles_type_garment_lower_name_key;
--   CREATE UNIQUE INDEX IF NOT EXISTS talles_type_lower_name_key
--     ON public.talles (type, lower(name));
--   ALTER TABLE public.talles DROP CONSTRAINT IF EXISTS talles_garment_check;
--   ALTER TABLE public.talles DROP COLUMN IF EXISTS garment;
-- COMMIT;
-- NOTIFY pgrst, 'reload schema';
