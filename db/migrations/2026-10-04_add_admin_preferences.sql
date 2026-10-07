-- ============================================================================
-- Preferencias de UI por administrador — 2026-10-04
--
-- CONTEXTO
-- El panel admin va a mostrar un tutorial de ayuda en la pestaña "Variantes"
-- del formulario de producto, con la opción "No volver a mostrar". La decisión
-- tiene que ser POR ADMIN (no global) y sobrevivir a logout/otros dispositivos,
-- así que no sirve localStorage ni `site_content`.
--
-- FIX
-- Tabla `admin_preferences`: una fila por usuario con flags de UI. Hoy solo
-- `variants_tutorial_dismissed`; las próximas ayudas "no volver a mostrar" se
-- agregan como columnas boolean nuevas.
--
-- SEGURIDAD
-- Tabla aparte (no `profiles`): `profiles` tiene las escrituras revocadas a
-- propósito (rls_hardening) porque contiene `role`. Acá cada admin solo lee,
-- crea y edita SU fila (user_id = auth.uid()) y además debe ser admin.
-- Sin DELETE desde el cliente. Se borra en cascada con el usuario.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_preferences (
  "user_id" uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  "variants_tutorial_dismissed" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT admin_preferences_pkey PRIMARY KEY (user_id)
);

DROP TRIGGER IF EXISTS admin_preferences_set_updated_at ON public.admin_preferences;
CREATE TRIGGER admin_preferences_set_updated_at
  BEFORE UPDATE ON public.admin_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.admin_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_preferences FROM anon;
REVOKE DELETE ON public.admin_preferences FROM authenticated;

DROP POLICY IF EXISTS admin_preferences_select_own ON public.admin_preferences;
CREATE POLICY admin_preferences_select_own ON public.admin_preferences
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.is_admin());

DROP POLICY IF EXISTS admin_preferences_insert_own ON public.admin_preferences;
CREATE POLICY admin_preferences_insert_own ON public.admin_preferences
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_admin());

DROP POLICY IF EXISTS admin_preferences_update_own ON public.admin_preferences;
CREATE POLICY admin_preferences_update_own ON public.admin_preferences
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.is_admin())
  WITH CHECK (user_id = auth.uid() AND public.is_admin());

COMMIT;

-- Recargar el schema cache de PostgREST (si no, la tabla nueva da 404/400).
NOTIFY pgrst, 'reload schema';
