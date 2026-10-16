-- ============================================================================
-- PROPUESTO (NO APLICADO) — Atribuir al backend en audit_log.actor (SEC-L01)
--
-- CONTEXTO
--  El trigger `audit_row_change` (script 2026-10-13_security_hardening.sql, sección E)
--  guarda `actor = auth.uid()`. El backend conecta como `postgres`, así que para todo
--  lo que hace la API (precios, estado de pago, rol de usuarios) `actor` queda NULL y
--  no se sabe QUÉ admin lo hizo.
--
-- QUÉ HACE
--  El código del backend (utils/transaction.js, `setTransactionActor`) ya ejecuta, dentro
--  de la transacción de cada escritura admin, `SELECT set_config('app.actor', '<uuid>', true)`
--  con el id del usuario verificado por `authMiddleware` (nunca un valor del request).
--  Este script hace que el trigger lo lea:
--    actor = COALESCE(auth.uid(), <app.actor>)
--  `auth.uid()` tiene prioridad: una escritura por PostgREST no puede "disfrazarse" con
--  `app.actor`. Un valor mal formado devuelve NULL en vez de abortar la escritura auditada.
--  Mientras este script no se aplique, el backend sigue funcionando igual (el set_config
--  es inocuo) y `actor` sigue en NULL para lo que hace la API.
--
-- Idempotente. Orden: se puede aplicar antes o después de desplegar el backend.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.audit_actor()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  raw text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN auth.uid();
  END IF;
  raw := current_setting('app.actor', true);
  IF raw IS NULL OR raw = '' THEN
    RETURN NULL;
  END IF;
  RETURN raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_actor() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  watched text[] := CASE TG_TABLE_NAME
    WHEN 'productos' THEN ARRAY['price', 'discount', 'original_price', 'status']
    WHEN 'profiles'  THEN ARRAY['role', 'purchase_allowed_exclusive']
    WHEN 'ventas'    THEN ARRAY['payment_status', 'dispatch_status', 'total_price']
    ELSE ARRAY[]::text[]
  END;
  col text;
  changed boolean := TG_OP <> 'UPDATE';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOREACH col IN ARRAY watched LOOP
      IF old_row -> col IS DISTINCT FROM new_row -> col THEN changed := true; END IF;
    END LOOP;
  END IF;

  IF changed THEN
    INSERT INTO public.audit_log (actor, table_name, row_id, action, old_data, new_data)
    VALUES (public.audit_actor(), TG_TABLE_NAME, COALESCE(new_row ->> 'id', old_row ->> 'id'), TG_OP,
            old_row - 'password_hash', new_row - 'password_hash');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;

COMMIT;

-- VERIFICACION (después de editar el precio de un producto de prueba desde el panel
-- admin, que pasa por el backend):
--   SELECT at, actor, table_name, action, old_data->>'price', new_data->>'price'
--     FROM public.audit_log ORDER BY id DESC LIMIT 5;
--   -> `actor` debe ser el uuid del admin (antes era NULL).
-- Confirmar también que `anon`/`authenticated` no pueden ejecutar las funciones:
--   SELECT has_function_privilege('authenticated', 'public.audit_actor()', 'EXECUTE');  -- false
--
-- ROLLBACK (vuelve a `auth.uid()` a secas, el comportamiento actual):
--   BEGIN;
--   CREATE OR REPLACE FUNCTION public.audit_row_change() ... (cuerpo de la sección E de
--     2026-10-13_security_hardening.sql, con `auth.uid()` en lugar de `public.audit_actor()`);
--   DROP FUNCTION IF EXISTS public.audit_actor();
--   COMMIT;
