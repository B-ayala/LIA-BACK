-- ============================================================================
-- APLICADO 2026-10-24 — H-14 — audit_log: índices, payload acotado y purga — 2026-10-24
--
-- CONTEXTO
--  Script 2026-10-13_security_hardening.sql creó `audit_log` sin índices y el trigger
--  `audit_row_change` guarda la fila ENTERA (to_jsonb) en old_data/new_data en cada
--  UPDATE vigilado. Una venta o un producto con `images`/`variants` genera cientos de
--  bytes a varios KB por cambio de estado, y la tabla crece sin límite.
--
-- QUÉ HACE
--  1. Índices: (table_name, row_id, at DESC) para "historial de una fila" y (at) para
--     la purga por antigüedad.
--  2. `audit_row_change`: en UPDATE guarda SOLO las columnas vigiladas (más el id);
--     en INSERT y DELETE sigue guardando la fila completa (es la única copia que
--     queda de un producto borrado). Conserva `audit_actor()` del script 2026-10-16.
--  3. `purge_audit_log(retention)`: borra filas más viejas que el plazo. NO se
--     agenda: el plazo de retención está sin definir (decisión de negocio/legal).
--
-- QUÉ NO ROMPE
--  El único lector es el test de integración (`SELECT actor ...`), que no usa
--  old_data/new_data. Cambia el contenido de esos jsonb en UPDATE: quien consulte
--  `old_data->>'price'` o `new_data->>'payment_status'` sigue funcionando porque
--  son columnas vigiladas; otras columnas (p. ej. `stock`) ya no aparecen en UPDATE.
--  Idempotente. Requiere haber aplicado 2026-10-13_security_hardening y 2026-10-16_audit_actor.
-- ============================================================================
BEGIN;

CREATE INDEX IF NOT EXISTS idx_audit_log_table_row_at
  ON public.audit_log (table_name, row_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_at
  ON public.audit_log (at);

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
  old_data jsonb;
  new_data jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_data := jsonb_build_object('id', old_row -> 'id');
    new_data := jsonb_build_object('id', new_row -> 'id');
    FOREACH col IN ARRAY watched LOOP
      IF old_row -> col IS DISTINCT FROM new_row -> col THEN
        changed := true;
      END IF;
      old_data := old_data || jsonb_build_object(col, old_row -> col);
      new_data := new_data || jsonb_build_object(col, new_row -> col);
    END LOOP;
  ELSE
    old_data := old_row - 'password_hash';
    new_data := new_row - 'password_hash';
  END IF;

  IF changed THEN
    INSERT INTO public.audit_log (actor, table_name, row_id, action, old_data, new_data)
    VALUES (public.audit_actor(), TG_TABLE_NAME, COALESCE(new_row ->> 'id', old_row ->> 'id'), TG_OP,
            old_data, new_data);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;

-- Sin DEFAULT a propósito: el plazo no está decidido, que nadie purgue sin elegirlo.
CREATE OR REPLACE FUNCTION public.purge_audit_log(retention interval)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted bigint;
BEGIN
  IF retention < interval '30 days' THEN
    RAISE EXCEPTION 'retención mínima 30 días, recibido %', retention;
  END IF;
  DELETE FROM public.audit_log WHERE at < now() - retention;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.purge_audit_log(interval) FROM PUBLIC, anon, authenticated;

COMMIT;

-- VERIFICACION:
--   1) Cambiar el precio de un producto de prueba desde el panel y:
--      SELECT at, actor, old_data, new_data FROM public.audit_log ORDER BY id DESC LIMIT 3;
--      -> old_data/new_data con solo id, price, discount, original_price, status.
--   2) SELECT public.purge_audit_log(interval '10 days');  -- debe fallar (mínimo 30 días)
--   3) Dry-run de la purga:
--      SELECT count(*) FROM public.audit_log WHERE at < now() - interval '12 months';
--
-- AGENDAR LA PURGA (solo cuando se defina el plazo; requiere pg_cron habilitado):
--   SELECT cron.schedule('purge-audit-log', '0 4 * * 0',
--     $$SELECT public.purge_audit_log(interval '12 months')$$);
--
-- ROLLBACK: volver a la función de 2026-10-16_audit_actor.sql (fila entera) y
--   DROP FUNCTION IF EXISTS public.purge_audit_log(interval);
--   DROP INDEX IF EXISTS public.idx_audit_log_table_row_at, public.idx_audit_log_at;
