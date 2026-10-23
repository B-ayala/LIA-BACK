-- ============================================================================
-- APLICADO 2026-10-16 — Acotar el nombre que llega en el alta de usuarios (SEC-N10)
--
-- CONTEXTO
--  `handle_new_user` copia `raw_user_meta_data->>'name'` a `profiles.name` sin límite.
--  El registro va directo del navegador a Supabase Auth, así que cualquier persona puede
--  crear una cuenta con un nombre enorme (el backend solo valida 100 caracteres al EDITAR).
--  Ese texto después se lista en el panel de usuarios del admin.
--
-- QUÉ HACE
--  Corta el nombre a 100 caracteres al crear el perfil (no rechaza el alta: un CHECK podría
--  romper el registro de un usuario legítimo con un nombre largo). Mantiene el
--  `search_path` fijo y el REVOKE del script 2026-10-13_security_hardening.sql, sección A.
--
-- Idempotente.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.profiles (id, name, role)
  VALUES (NEW.id, left(NULLIF(NEW.raw_user_meta_data->>'name', ''), 100), 'user')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

COMMIT;

-- VERIFICACION:
--   SELECT proconfig FROM pg_proc WHERE proname = 'handle_new_user';   -- {search_path=public, pg_temp}
--   Registrar un usuario de prueba con un nombre de 300 caracteres y comprobar
--   SELECT char_length(name) FROM public.profiles ORDER BY created_at DESC LIMIT 1;  -- 100
--
-- ROLLBACK: volver a crear la función sin `left(..., 100)` (cuerpo en db/migracion-nueva-cuenta/01_schema_public.sql)
--   conservando `SET search_path = public, pg_temp`.
