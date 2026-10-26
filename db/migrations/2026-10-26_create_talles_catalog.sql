-- ============================================================================
-- Catálogo de talles — 2026-10-26  (PENDIENTE de aplicar)
--
-- CONTEXTO
-- Los talles y sus medidas vivían copiados dentro de cada producto
-- (`productos.size_guide`). El negocio quiere definirlos una sola vez
-- (p. ej. "M" de indumentaria con sus medidas) y reutilizarlos en los productos.
--
-- FIX
-- Tabla `talles`: una fila por talle, con tipo (indumentaria / calzado), medidas
-- como objeto etiqueta -> valor y un flag `active` (los talles no se borran, se
-- desactivan, porque productos existentes pueden seguir referenciándolos desde
-- `variants[].optionMeta`). `productos.size_guide` queda como legado de solo lectura.
--
-- SEGURIDAD
-- Lectura pública (anon + authenticated). Escritura solo admin vía
-- public.is_admin() y, además, sin GRANT de escritura para anon/authenticated
-- (mismo criterio que `productos` en 2026-10-13_security_hardening.sql, sección
-- B): la escritura real va por la API del backend, que conecta como `postgres`.
--
-- CÓMO APLICAR
--  Supabase -> SQL Editor -> pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.talles (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "measurements" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'talles_pkey' AND conrelid = 'public.talles'::regclass) THEN
    ALTER TABLE public.talles ADD CONSTRAINT talles_pkey PRIMARY KEY (id);
  END IF;
END $$;

ALTER TABLE public.talles DROP CONSTRAINT IF EXISTS talles_name_check;
ALTER TABLE public.talles ADD CONSTRAINT talles_name_check
  CHECK (char_length(btrim(name)) BETWEEN 1 AND 20 AND name = btrim(name));

ALTER TABLE public.talles DROP CONSTRAINT IF EXISTS talles_type_check;
ALTER TABLE public.talles ADD CONSTRAINT talles_type_check
  CHECK (type IN ('indumentaria', 'calzado'));

ALTER TABLE public.talles DROP CONSTRAINT IF EXISTS talles_measurements_check;
ALTER TABLE public.talles ADD CONSTRAINT talles_measurements_check
  CHECK (jsonb_typeof(measurements) = 'object');

CREATE UNIQUE INDEX IF NOT EXISTS talles_type_lower_name_key
  ON public.talles (type, lower(name));

DROP TRIGGER IF EXISTS talles_set_updated_at ON public.talles;
CREATE TRIGGER talles_set_updated_at
  BEFORE UPDATE ON public.talles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.talles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS talles_select_public ON public.talles;
CREATE POLICY talles_select_public ON public.talles
  AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS talles_insert_admin ON public.talles;
CREATE POLICY talles_insert_admin ON public.talles
  AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS talles_update_admin ON public.talles;
CREATE POLICY talles_update_admin ON public.talles
  AS PERMISSIVE FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS talles_delete_admin ON public.talles;
CREATE POLICY talles_delete_admin ON public.talles
  AS PERMISSIVE FOR DELETE TO authenticated USING (public.is_admin());

REVOKE INSERT, UPDATE, DELETE ON public.talles FROM anon, authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.talles FROM anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT policyname, roles, cmd, qual FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'talles';
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'talles'
--    AND grantee IN ('anon', 'authenticated');   -- debe quedar solo SELECT
-- INSERT de prueba desde la API (POST /api/sizes) con "m" y luego con "M" del
-- mismo tipo: el segundo debe fallar por el índice único.

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.talles;
-- COMMIT;
-- NOTIFY pgrst, 'reload schema';
