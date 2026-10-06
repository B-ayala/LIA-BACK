-- ============================================================================
-- ventas: acotar permisos de UPDATE desde el cliente (supabase-js) — 2026-10-06
--
-- POR QUÉ
-- Hoy anon y authenticated tienen UPDATE de TODA la tabla (GRANT SELECT, UPDATE).
-- La policy `ventas_update_admin` limita QUÉ FILAS puede tocar un admin, pero no
-- QUÉ COLUMNAS: una sesión admin comprometida (o un bug del front) podría reescribir
-- payment_status, total_price, buyer_email, etc. directo contra PostgREST, salteando
-- la lógica del backend (confirm-transfer, cancel-transfer, webhook MP).
--
-- QUÉ USA EL FRONT (búsqueda en front/damiana-bella/src, único acceso a `ventas`):
--   UPDATE: Dispatches.tsx:126  supabase.from('ventas').update({ dispatch_status })
--           -> única columna escrita por el cliente.
--   SELECT: Sales.tsx y Dispatches.tsx (solo lectura, vía policy ventas_select_admin).
--   INSERT/DELETE ya están revocados (2026-08-09_rls_hardening.sql).
--   Pagos/cancelaciones de transferencia pasan por el backend (rol postgres).
--
-- QUÉ NO SE AFECTA
--  - Backend: corre como `postgres`/service_role, ignora estos GRANT.
--  - trg_set_ventas_status_timestamps (BEFORE UPDATE): asigna paid_at/cancelled_at/
--    dispatched_at sobre NEW; los privilegios de columna se chequean contra las
--    columnas del SET de la sentencia, no contra lo que modifica un trigger.
--    Cambiar dispatch_status a 'despachado' sigue seteando dispatched_at.
--  - trg_decrement_stock es AFTER INSERT: el cliente ya no inserta.
--
-- La policy `ventas_update_admin` (solo admins) se conserva sin cambios.
-- Idempotente: REVOKE/GRANT se pueden repetir sin efecto adicional.
-- ============================================================================

BEGIN;

-- anon no tiene motivo para tocar ventas: la policy de SELECT ya devuelve 0 filas
-- sin sesión admin, y esto cierra además cualquier privilegio residual.
REVOKE ALL ON public.ventas FROM anon;

-- Quita el UPDATE a nivel tabla y lo devuelve solo en la columna que el front edita.
REVOKE UPDATE ON public.ventas FROM anon, authenticated;
GRANT UPDATE (dispatch_status) ON public.ventas TO authenticated;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (después de aplicar)
-- ============================================================================
-- Privilegios de columna efectivos para authenticated (debe listar solo dispatch_status):
--   SELECT column_name, privilege_type
--     FROM information_schema.column_privileges
--    WHERE table_schema = 'public' AND table_name = 'ventas'
--      AND grantee = 'authenticated' AND privilege_type = 'UPDATE';
-- Como admin en el panel: cambiar el estado de un despacho debe seguir funcionando
-- y, si pasa a 'despachado', dispatched_at debe quedar seteado.
-- Si algo falla, rollback: GRANT UPDATE ON public.ventas TO authenticated;
