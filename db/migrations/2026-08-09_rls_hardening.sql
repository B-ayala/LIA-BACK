-- ============================================================================
-- Endurecimiento de RLS y permisos — 2026-08-09
--
-- CONTEXTO
-- La `anon key` de Supabase es pública: viaja en el bundle del frontend, así que
-- cualquiera en internet puede usarla contra la API REST de Supabase. Hoy varias
-- tablas de `public` tienen RLS DESACTIVADA y permisos completos para `anon` y
-- `authenticated`, lo que permite leerlas y escribirlas sin ser admin.
--
-- El caso más grave es `public.profiles`: sin RLS y con UPDATE concedido,
-- cualquiera puede ejecutar
--     UPDATE profiles SET role = 'admin' WHERE id = '<su propio uuid>';
-- y convertirse en admin. Como `authMiddleware` lee el rol de esa misma tabla,
-- eso otorga acceso completo al panel y a la API de administración.
--
-- Además, el privilegio TRUNCATE **no está sujeto a RLS**: hoy `anon` puede
-- vaciar `productos` o `ventas` aunque las políticas de fila estén bien.
--
-- QUÉ NO ROMPE
--  - El backend conecta como `postgres` (dueño de las tablas) y por lo tanto
--    NO está sujeto a RLS: todos los endpoints siguen funcionando igual.
--  - `handle_new_user` es SECURITY DEFINER (owner `postgres`), así que el alta
--    de perfiles en el signup sigue funcionando con RLS activada.
--  - Se conservan explícitamente los accesos que hoy usa el frontend con la
--    anon key: lectura pública de catálogo, categorías, carrusel y contenido
--    del sitio; lectura del perfil propio; y escritura de admin desde el panel.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
--  Al final hay un bloque de VERIFICACIÓN y otro de ROLLBACK comentado.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Helper de rol admin
--
-- SECURITY DEFINER a propósito: se ejecuta como `postgres`, que no está sujeto a
-- RLS. Sin esto, una política sobre `profiles` que consulte `profiles` entraría
-- en recursión infinita.
-- `search_path` fijo para que no pueda secuestrarse con un esquema del usuario.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = auth.uid() AND role = 'admin'
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- ----------------------------------------------------------------------------
-- 1. TRUNCATE fuera del alcance de la anon key (no lo frena RLS)
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 2. profiles — el agujero crítico (escalada de privilegios + PII)
--
-- Contiene `email`, `phone` y `password_hash` (legado). Queda: cada usuario ve
-- solo su propia fila; el admin ve todas. Ninguna escritura desde la anon key:
-- el alta la hace el trigger (SECURITY DEFINER) y la edición el backend.
-- ----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM anon, authenticated;

DROP POLICY IF EXISTS profiles_select_self_or_admin ON public.profiles;
CREATE POLICY profiles_select_self_or_admin ON public.profiles
  FOR SELECT TO anon, authenticated
  USING (id = auth.uid() OR public.is_admin());

-- ----------------------------------------------------------------------------
-- 3. ventas — cerrar el INSERT público
--
-- `ventas_insert_public` tenía CHECK (true): cualquiera podía insertar ventas y,
-- como el trigger `trg_decrement_stock` descuenta al insertar, vaciar el stock
-- sin comprar. Desde el fix de BUG-001 las altas van por el backend
-- (POST /api/orders/transfer), que corre como `postgres` y no necesita política.
-- Las políticas de SELECT/UPDATE de admin ya existentes se conservan.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS ventas_insert_public ON public.ventas;
REVOKE INSERT, DELETE ON public.ventas FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. ventas_archivadas — histórico con PII de compradores (34 filas hoy)
-- ----------------------------------------------------------------------------
ALTER TABLE public.ventas_archivadas ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.ventas_archivadas FROM anon, authenticated;

DROP POLICY IF EXISTS ventas_archivadas_select_admin ON public.ventas_archivadas;
CREATE POLICY ventas_archivadas_select_admin ON public.ventas_archivadas
  FOR SELECT TO anon, authenticated
  USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 5. site_content y carousel_images — lectura pública, escritura de admin
--
-- El panel admin escribe estas tablas con la anon key (ThemesManager hace upsert,
-- HomeManager gestiona el carrusel), así que hacen falta políticas de escritura
-- para admin: sin ellas se rompería el panel.
-- ----------------------------------------------------------------------------
ALTER TABLE public.site_content ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS site_content_select_public ON public.site_content;
CREATE POLICY site_content_select_public ON public.site_content
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS site_content_insert_admin ON public.site_content;
CREATE POLICY site_content_insert_admin ON public.site_content
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS site_content_update_admin ON public.site_content;
CREATE POLICY site_content_update_admin ON public.site_content
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS site_content_delete_admin ON public.site_content;
CREATE POLICY site_content_delete_admin ON public.site_content
  FOR DELETE TO authenticated USING (public.is_admin());

ALTER TABLE public.carousel_images ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS carousel_select_public ON public.carousel_images;
CREATE POLICY carousel_select_public ON public.carousel_images
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS carousel_insert_admin ON public.carousel_images;
CREATE POLICY carousel_insert_admin ON public.carousel_images
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS carousel_update_admin ON public.carousel_images;
CREATE POLICY carousel_update_admin ON public.carousel_images
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS carousel_delete_admin ON public.carousel_images;
CREATE POLICY carousel_delete_admin ON public.carousel_images
  FOR DELETE TO authenticated USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 6. contact_messages — alta pública, lectura solo admin
-- ----------------------------------------------------------------------------
ALTER TABLE public.contact_messages ENABLE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE ON public.contact_messages FROM anon, authenticated;

DROP POLICY IF EXISTS contact_insert_public ON public.contact_messages;
CREATE POLICY contact_insert_public ON public.contact_messages
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS contact_select_admin ON public.contact_messages;
CREATE POLICY contact_select_admin ON public.contact_messages
  FOR SELECT TO anon, authenticated USING (public.is_admin());

-- ----------------------------------------------------------------------------
-- 7. email_tokens y refresh_tokens — legado del esquema de auth propio
--
-- Hoy están vacías y no las referencia ninguna línea de código (la sesión la
-- maneja Supabase Auth). Se cierran por completo en vez de borrarlas: si alguna
-- vez guardaron tokens, quedaban al alcance de cualquiera con la anon key.
-- RLS activada SIN políticas = nadie salvo el dueño (`postgres`) accede.
-- ----------------------------------------------------------------------------
ALTER TABLE public.email_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refresh_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_tokens FROM anon, authenticated;
REVOKE ALL ON public.refresh_tokens FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 8. productos y categories — RLS ya estaba bien; solo se acota la escritura
--    directa con la anon key (el alta/edición real va por la API del backend).
-- ----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.productos FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.categories FROM anon;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (ejecutar después; debe dar RLS activa en todas las tablas)
-- ============================================================================
-- SELECT c.relname, c.relrowsecurity
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1;
--
-- SELECT table_name, grantee, string_agg(privilege_type, ',') AS privs
--   FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
--  GROUP BY 1,2 ORDER BY 1,2;

-- ============================================================================
-- ROLLBACK (solo si algo del panel dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.profiles          DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.site_content      DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.carousel_images   DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.contact_messages  DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.ventas_archivadas DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.email_tokens      DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.refresh_tokens    DISABLE ROW LEVEL SECURITY;
--   GRANT INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
-- COMMIT;
