-- ============================================================================
-- Timestamps de transición de estado en ventas — 2026-09-18
--
-- CONTEXTO
-- Hallazgo H-010 de la auditoría de usuarios/ventas: `payment_status` y
-- `dispatch_status` cambian de valor sin dejar registro de CUÁNDO cambiaron
-- (solo hay `created_at`, que es la fecha de creación de la orden). Sin esto
-- no se puede medir tiempo hasta el pago ni tiempo hasta el despacho de
-- órdenes ya cerradas.
--
-- POR QUÉ UN TRIGGER Y NO SOLO CÓDIGO EN EL BACKEND
-- `payment_status` cambia desde el backend (mp-confirm, webhook,
-- confirm-transfer, cancel-transfer, cancel, sweep de expiración), pero
-- `dispatch_status` se actualiza directo desde el panel admin con la anon key
-- (política `ventas_update_admin`, sin pasar por ningún endpoint del backend
-- — confirmado: no hay ninguna ruta `/api/orders/*dispatch*`). Un trigger en
-- la base es el único lugar que ve las dos vías de escritura sin tener que
-- tocar el frontend (que vive en otro repo).
--
-- QUÉ NO ROMPE
--  - Columnas nuevas NULLABLE: ninguna fila ni query existente cambia de
--    comportamiento.
--  - El trigger es BEFORE UPDATE y solo asigna las columnas nuevas cuando el
--    estado realmente cambia (no pisa un timestamp ya seteado si el estado
--    vuelve a escribirse igual, ej. un UPDATE que toca otra columna).
--  - No hay backfill de filas históricas: inventar un `paid_at` = `created_at`
--    para ventas ya cerradas sería un dato falso (no sabemos cuándo pasó
--    realmente). Quedan NULL a propósito; el trigger cubre todo lo que pase
--    de acá en adelante.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS paid_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispatched_at timestamptz;

CREATE OR REPLACE FUNCTION public.set_ventas_status_timestamps()
RETURNS trigger AS $$
BEGIN
  IF NEW.payment_status = 'pagado' AND (OLD.payment_status IS DISTINCT FROM 'pagado') THEN
    NEW.paid_at := now();
  END IF;

  IF NEW.payment_status IN ('cancelado', 'expirado')
     AND OLD.payment_status IS DISTINCT FROM NEW.payment_status THEN
    NEW.cancelled_at := now();
  END IF;

  IF NEW.dispatch_status = 'despachado' AND (OLD.dispatch_status IS DISTINCT FROM 'despachado') THEN
    NEW.dispatched_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_ventas_status_timestamps ON public.ventas;
CREATE TRIGGER trg_set_ventas_status_timestamps
  BEFORE UPDATE ON public.ventas
  FOR EACH ROW
  EXECUTE FUNCTION public.set_ventas_status_timestamps();

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (ejecutar después; probar cambiando un estado real de prueba)
-- ============================================================================
-- SELECT id, payment_status, paid_at, cancelled_at, dispatch_status, dispatched_at
--   FROM public.ventas ORDER BY created_at DESC LIMIT 10;

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   DROP TRIGGER IF EXISTS trg_set_ventas_status_timestamps ON public.ventas;
--   DROP FUNCTION IF EXISTS public.set_ventas_status_timestamps();
--   ALTER TABLE public.ventas
--     DROP COLUMN IF EXISTS paid_at,
--     DROP COLUMN IF EXISTS cancelled_at,
--     DROP COLUMN IF EXISTS dispatched_at;
-- COMMIT;
