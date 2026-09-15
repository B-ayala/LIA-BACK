-- ============================================================================
-- Restringir lectura pública de productos inactivos — 2026-09-15
--
-- CONTEXTO
-- La policy "Allow public read" en public.productos usa USING (true): cualquiera
-- con la anon key (pública, va en el bundle del front) puede leer TODAS las filas,
-- incluidos los productos "inactive", llamando directo a la API REST de Supabase.
-- Hoy el ocultamiento de inactivos depende solo del filtro `.eq('status','active')`
-- que agrega el frontend (productService.ts) — no hay nada del lado de la base
-- que lo garantice. Broken Access Control (OWASP #6): no hay que confiar en que
-- el cliente aplique el filtro.
--
-- FIX
-- Reemplaza esa policy por una que solo deja ver productos inactivos a admins
-- (reutiliza public.is_admin(), ya creado en 2026-08-09_rls_hardening.sql).
--
-- QUÉ NO ROMPE
--  - El backend conecta como `postgres` (dueño de la tabla): no está sujeto a RLS,
--    así que el panel admin (que lee vía API propia, no Supabase directo) sigue
--    viendo todos los productos igual.
--  - Si en algún punto el panel llegara a leer productos directo con supabase-js
--    logueado como admin, `public.is_admin()` lo sigue dejando ver todo.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "Allow public read" ON public.productos;
DROP POLICY IF EXISTS productos_select_active_or_admin ON public.productos;

CREATE POLICY productos_select_active_or_admin ON public.productos
  FOR SELECT TO anon, authenticated
  USING (status = 'active' OR public.is_admin());

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT policyname, roles, qual FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'productos';

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   DROP POLICY IF EXISTS productos_select_active_or_admin ON public.productos;
--   CREATE POLICY "Allow public read" ON public.productos
--     FOR SELECT TO public USING (true);
-- COMMIT;
