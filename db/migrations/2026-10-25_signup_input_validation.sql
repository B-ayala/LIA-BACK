-- ============================================================================
-- PENDIENTE DE APLICAR — Validar nombre y celular en el alta de usuarios (SEC-N10, 2da parte)
--
-- CONTEXTO
--  El alta va directo del navegador a Supabase Auth (supabase.auth.signUp), así que las
--  validaciones del formulario no frenan a quien llame a la API de Auth con su propio script.
--  El script 2026-10-16_signup_name_length.sql solo cortaba el nombre a 100 caracteres y
--  aceptaba cualquier contenido ("ffff…", HTML, emojis).
--
-- QUÉ HACE
--  `handle_new_user` (trigger AFTER INSERT en auth.users) ahora RECHAZA el alta, con rollback
--  de la cuenta, si el nombre o el celular de `raw_user_meta_data` no cumplen:
--    · name : 2 a 60 caracteres, empieza con letra; letras, espacios, apóstrofe, punto y guion.
--    · phone: 7 a 20 caracteres; dígitos, espacios, guiones, paréntesis y un "+" inicial.
--  Un nombre ausente o vacío se sigue admitiendo (usuarios creados desde el panel de Supabase).
--  Mismas reglas que el frontend (utils/validation.ts) y el backend (utils/userValidation.js).
--  Mantiene el `search_path` fijo y el REVOKE del script 2026-10-13_security_hardening.sql, sección A.
--
-- NO CUBRE la contraseña: llega hasheada al trigger. Su política (8 a 64 caracteres, letra,
-- número y símbolo) se configura en el panel de Supabase (Authentication → Sign In / Providers
-- → Email → Password requirements). Ver CHANGELOG.
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
DECLARE
  v_name  text := btrim(NULLIF(NEW.raw_user_meta_data->>'name', ''));
  v_phone text := btrim(NULLIF(NEW.raw_user_meta_data->>'phone', ''));
BEGIN
  IF v_name IS NOT NULL AND (
       char_length(v_name) NOT BETWEEN 2 AND 60
       OR v_name !~ '^[[:alpha:]][[:alpha:]''. -]*$'
     ) THEN
    RAISE EXCEPTION 'invalid_name' USING ERRCODE = 'check_violation';
  END IF;

  IF v_phone IS NOT NULL AND (
       char_length(v_phone) NOT BETWEEN 7 AND 20
       OR v_phone !~ '^\+?[0-9 ()-]+$'
     ) THEN
    RAISE EXCEPTION 'invalid_phone' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.profiles (id, name, role)
  VALUES (NEW.id, v_name, 'user')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

COMMIT;

-- VERIFICACION (contra la API de Auth, con la anon key, desde un entorno de prueba):
--   POST /auth/v1/signup con data.name = "<script>alert(1)</script>"  -> error (500 "Database error saving new user"), sin fila en auth.users
--   POST /auth/v1/signup con data.name = "f" * 61                     -> error
--   POST /auth/v1/signup con data.name = "María-José O'Brien"         -> alta OK, profiles.name = "María-José O'Brien"
--   SELECT proconfig FROM pg_proc WHERE proname = 'handle_new_user';   -- {search_path=public, pg_temp}
--
-- ROLLBACK: volver a aplicar 2026-10-16_signup_name_length.sql.
