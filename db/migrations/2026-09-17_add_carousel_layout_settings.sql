-- ============================================================================
-- Configuración de layout del carrusel (por dispositivo) — 2026-09-17
--
-- CONTEXTO
-- El carrusel del home agrupaba siempre 2 (mobile) o 3 (desktop) imágenes por
-- slide en un collage a pantalla casi completa. Con fotos verticales de
-- personas eso fuerza un recorte muy agresivo (cover sobre un marco angosto y
-- alto). El admin pidió poder elegir, desde su panel, si un slide muestra una
-- sola imagen a pantalla ancha (banner) o el collage de varias — sin tocar
-- código, y por separado para desktop y mobile.
--
-- FIX
-- Tabla chica de configuración `carousel_settings`, una fila por device_type,
-- con el layout elegido. Se pre-siembran ambas filas en 'collage' (el
-- comportamiento actual) para no cambiar nada hasta que el admin lo toque.
--
-- SEGURIDAD
-- Lectura pública (el home la necesita sin login). Escritura solo admin
-- (reutiliza public.is_admin(), ya creado en 2026-08-09_rls_hardening.sql).
-- A diferencia de carousel_images, acá NO se le da GRANT de escritura a
-- anon/authenticated: solo SELECT. RLS ya alcanzaría para bloquear updates
-- de no-admins, pero no tiene sentido otorgar el permiso si nadie salvo el
-- admin autenticado debería poder usarlo (mínimo privilegio).
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.carousel_settings (
  "device_type" text NOT NULL,
  "layout" text NOT NULL DEFAULT 'collage',
  "updated_at" timestamp with time zone DEFAULT now()
);

ALTER TABLE public.carousel_settings ADD CONSTRAINT carousel_settings_pkey PRIMARY KEY (device_type);
ALTER TABLE public.carousel_settings ADD CONSTRAINT carousel_settings_device_type_check
  CHECK (device_type IN ('desktop', 'mobile'));
ALTER TABLE public.carousel_settings ADD CONSTRAINT carousel_settings_layout_check
  CHECK (layout IN ('single', 'collage'));

DROP TRIGGER IF EXISTS carousel_settings_set_updated_at ON public.carousel_settings;
CREATE TRIGGER carousel_settings_set_updated_at
  BEFORE UPDATE ON public.carousel_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.carousel_settings (device_type, layout) VALUES
  ('desktop', 'collage'),
  ('mobile', 'collage')
ON CONFLICT (device_type) DO NOTHING;

ALTER TABLE public.carousel_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS carousel_settings_select_public ON public.carousel_settings;
CREATE POLICY carousel_settings_select_public ON public.carousel_settings
  AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS carousel_settings_update_admin ON public.carousel_settings;
CREATE POLICY carousel_settings_update_admin ON public.carousel_settings
  AS PERMISSIVE FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

REVOKE ALL ON public.carousel_settings FROM anon, authenticated;
GRANT SELECT ON public.carousel_settings TO anon;
GRANT SELECT, UPDATE ON public.carousel_settings TO authenticated;
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON public.carousel_settings TO service_role;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT * FROM public.carousel_settings;
-- SELECT policyname, roles, cmd, qual FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'carousel_settings';

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.carousel_settings;
-- COMMIT;
