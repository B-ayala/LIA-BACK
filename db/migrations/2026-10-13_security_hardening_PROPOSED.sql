-- ============================================================================
-- Endurecimiento de base de datos — 2026-10-13  (PROPUESTO: NO EJECUTADO)
--
-- Este script salió de la auditoría de seguridad (SECURITY_AUDIT_REPORT.md,
-- hallazgos SEC-C02, SEC-C03, SEC-C04, SEC-C05 y SEC-L01). Nadie lo aplicó:
-- necesita aprobación y se corre a mano en Supabase -> SQL Editor.
--
-- Cada sección es independiente: se puede pegar y ejecutar por separado.
-- Todo es idempotente. El backend corre como `postgres` (ignora RLS y GRANTs),
-- así que ninguna sección cambia lo que hace la API.
--
-- ANTES DE APLICAR: probar en un proyecto de staging o, como mínimo, correr el
-- bloque de VERIFICACION de cada sección y recorrer el panel admin
-- (productos destacados, despachos, usuarios, ventas) y el formulario de contacto.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- A. Funciones SECURITY DEFINER sin search_path fijo (SEC-C02)
--
-- decrement_stock_on_sale() y handle_new_user() se ejecutan con los privilegios
-- de su dueño y no fijan search_path: un objeto homónimo en un esquema anterior
-- del search_path del invocador podría secuestrarlas. Además son funciones de
-- trigger: no hay motivo para que anon/authenticated tengan EXECUTE (los
-- triggers no chequean EXECUTE al dispararse).
-- ----------------------------------------------------------------------------
BEGIN;

ALTER FUNCTION public.decrement_stock_on_sale() SET search_path = public, pg_temp;
ALTER FUNCTION public.handle_new_user()          SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.decrement_stock_on_sale() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()          FROM PUBLIC, anon, authenticated;

COMMIT;

-- VERIFICACION
-- SELECT p.proname, p.prosecdef, p.proconfig
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public' AND p.proname IN ('decrement_stock_on_sale','handle_new_user');
-- Registrar un usuario de prueba y comprar un producto de prueba: el perfil y
-- el descuento de stock deben seguir funcionando.


-- ----------------------------------------------------------------------------
-- B. productos: sin escritura directa con la sesión admin (SEC-C03)
--
-- Hoy `authenticated` tiene INSERT/UPDATE/DELETE sobre toda `productos` y solo
-- la policy "solo admins" lo limita. Un token admin robado (un JWT sigue siendo
-- válido en PostgREST hasta que vence, aunque se haga logout) podría cambiar
-- precio o stock salteando el backend. El único acceso directo que hace el
-- front es `update({ featured })` (services/productService.ts) y el alta/edición/
-- baja real va por la API. Se deja solo esa columna.
-- ----------------------------------------------------------------------------
BEGIN;

REVOKE INSERT, UPDATE, DELETE ON public.productos FROM authenticated;
GRANT UPDATE (featured) ON public.productos TO authenticated;

COMMIT;

-- VERIFICACION (debe listar solo `featured`):
-- SELECT column_name FROM information_schema.column_privileges
--  WHERE table_schema = 'public' AND table_name = 'productos'
--    AND grantee = 'authenticated' AND privilege_type = 'UPDATE';
-- Panel admin: marcar/desmarcar "destacado" debe seguir andando; crear, editar
-- y borrar productos (API del backend) también.
-- ROLLBACK: GRANT INSERT, UPDATE, DELETE ON public.productos TO authenticated;


-- ----------------------------------------------------------------------------
-- C. CHECK de dominio en ventas y productos (SEC-C04)
--
-- Una segunda barrera por si algún script o bug escribe valores imposibles.
-- NOT VALID: no revisa las filas existentes (no falla por datos viejos) pero
-- sí todas las escrituras nuevas. Después de revisar los datos se puede
-- ejecutar el VALIDATE comentado.
-- ----------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.ventas DROP CONSTRAINT IF EXISTS ventas_payment_status_domain;
ALTER TABLE public.ventas ADD CONSTRAINT ventas_payment_status_domain
  CHECK (payment_status IN ('pendiente', 'pagado', 'cancelado', 'expirado', 'fallido')) NOT VALID;

ALTER TABLE public.ventas DROP CONSTRAINT IF EXISTS ventas_amounts_sane;
ALTER TABLE public.ventas ADD CONSTRAINT ventas_amounts_sane
  CHECK (quantity > 0 AND unit_price >= 0 AND total_price >= 0) NOT VALID;

ALTER TABLE public.productos DROP CONSTRAINT IF EXISTS productos_price_sane;
ALTER TABLE public.productos ADD CONSTRAINT productos_price_sane
  CHECK (price >= 0 AND (discount IS NULL OR (discount >= 0 AND discount <= 100))) NOT VALID;

COMMIT;

-- Revisar antes de validar (deben dar 0 filas):
-- SELECT DISTINCT payment_status FROM public.ventas;
-- SELECT count(*) FROM public.ventas WHERE quantity <= 0 OR unit_price < 0 OR total_price < 0;
-- SELECT count(*) FROM public.productos WHERE price < 0 OR discount < 0 OR discount > 100;
-- ALTER TABLE public.ventas    VALIDATE CONSTRAINT ventas_payment_status_domain;
-- ALTER TABLE public.ventas    VALIDATE CONSTRAINT ventas_amounts_sane;
-- ALTER TABLE public.productos VALIDATE CONSTRAINT productos_price_sane;
-- ROLLBACK: ALTER TABLE ... DROP CONSTRAINT <nombre>;


-- ----------------------------------------------------------------------------
-- D. contact_messages: acotar lo que puede insertar un anónimo (SEC-C05)
--
-- La policy de INSERT es CHECK (true) para anon (el formulario de contacto
-- escribe directo con la anon key, sin pasar por el backend ni rate limit).
-- Sin tope de largo, cualquiera puede llenar la tabla con texto gigante.
-- Esto no frena el spam por volumen (eso requiere captcha o mover el formulario
-- al backend), pero acota el costo por mensaje.
-- ----------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.contact_messages DROP CONSTRAINT IF EXISTS contact_messages_lengths;
ALTER TABLE public.contact_messages ADD CONSTRAINT contact_messages_lengths
  CHECK (char_length(name) <= 120 AND char_length(email) <= 254
         AND char_length(subject) <= 200 AND char_length(message) <= 5000) NOT VALID;

COMMIT;

-- VERIFICACION: enviar un contacto normal desde el sitio (debe entrar) y uno
-- con mensaje > 5000 caracteres desde la consola (debe rechazarse).


-- ----------------------------------------------------------------------------
-- E. Auditoría persistente de cambios sensibles (SEC-L01)
--
-- Hoy no queda registro de quién cambió un precio, un rol o el estado de una
-- venta. Esta tabla guarda cambios de: precio/descuento/estado de productos,
-- rol y permiso de compra de perfiles, y estado de pago/despacho de ventas.
--
-- Limitación conocida: el backend conecta como `postgres`, así que `actor`
-- queda en NULL para lo que hace la API; las escrituras directas desde el
-- panel (PostgREST) sí registran el uid del admin. Para atribuir también lo
-- del backend hay que setear `SET LOCAL app.actor = '<uuid>'` en cada
-- transacción (cambio de código a decidir aparte).
-- ----------------------------------------------------------------------------
BEGIN;

CREATE TABLE IF NOT EXISTS public.audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      uuid,
  table_name text NOT NULL,
  row_id     text,
  action     text NOT NULL,
  old_data   jsonb,
  new_data   jsonb
);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_log FROM anon, authenticated;
GRANT SELECT ON public.audit_log TO authenticated;

DROP POLICY IF EXISTS audit_log_select_admin ON public.audit_log;
CREATE POLICY audit_log_select_admin ON public.audit_log
  FOR SELECT TO authenticated USING (public.is_admin());

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
    VALUES (auth.uid(), TG_TABLE_NAME, COALESCE(new_row ->> 'id', old_row ->> 'id'), TG_OP,
            old_row - 'password_hash', new_row - 'password_hash');
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_productos ON public.productos;
CREATE TRIGGER trg_audit_productos AFTER INSERT OR UPDATE OR DELETE ON public.productos
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS trg_audit_profiles ON public.profiles;
CREATE TRIGGER trg_audit_profiles AFTER UPDATE OR DELETE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS trg_audit_ventas ON public.ventas;
CREATE TRIGGER trg_audit_ventas AFTER UPDATE ON public.ventas
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

COMMIT;

-- VERIFICACION: cambiar el precio de un producto de prueba desde el panel y
--   SELECT at, actor, table_name, action, old_data->>'price', new_data->>'price'
--     FROM public.audit_log ORDER BY id DESC LIMIT 5;
-- Los descuentos de stock por venta NO se registran a propósito (no se vigila `stock`).
-- RETENCION: la tabla crece con cada cambio; definir una purga (p. ej. > 12 meses).
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_audit_productos ON public.productos;
--   DROP TRIGGER IF EXISTS trg_audit_profiles  ON public.profiles;
--   DROP TRIGGER IF EXISTS trg_audit_ventas    ON public.ventas;
--   DROP FUNCTION IF EXISTS public.audit_row_change();
--   DROP TABLE IF EXISTS public.audit_log;
