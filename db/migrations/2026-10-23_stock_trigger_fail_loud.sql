-- ============================================================================
-- Trigger de stock sin clamp silencioso (H-07) — 2026-10-23
--
-- CONTEXTO
-- `decrement_stock_on_sale()` (AFTER INSERT en `ventas`) hacía
-- `stock = GREATEST(stock - NEW.quantity, 0)`: si alguna vez se insertaba una
-- venta por más stock del disponible, la sobreventa pasaba en silencio con el
-- stock en 0. El mecanismo principal sigue siendo el `SELECT ... FOR UPDATE` de
-- la reserva (serializa las compras del mismo producto); esto lo vuelve una
-- segunda barrera ruidosa: con `productos_stock_non_negative` (stock >= 0,
-- script 2026-08-18) el INSERT de la venta falla con 23514 y se revierte entero.
--
-- Esta versión también deja la definición del trigger versionada en el repo
-- (hasta ahora vivía solo en la base).
--
-- QUÉ NO CAMBIA
--  - El trigger `trg_decrement_stock` y sus rutas de restitución.
--  - `updated_at`: lo actualiza `update_productos_updated_at` (BEFORE UPDATE),
--    así que el control optimista `expectedUpdatedAt` ya detecta las compras.
--
-- PRE-CHEQUEO
--  Aborta si hubiera stock negativo o si faltara la constraint.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Idempotente.
--
-- ROLLBACK
--  Volver a crear la función con `GREATEST(stock - NEW.quantity, 0)`.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.productos WHERE stock < 0) THEN
    RAISE EXCEPTION 'Hay productos con stock negativo: corregirlos antes de aplicar';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.productos'::regclass AND conname = 'productos_stock_non_negative'
  ) THEN
    RAISE EXCEPTION 'Falta productos_stock_non_negative: aplicar 2026-08-18_add_stock_check_constraint.sql primero';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.decrement_stock_on_sale()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  UPDATE public.productos
  SET stock = stock - NEW.quantity
  WHERE id = NEW.product_id;
  RETURN NEW;
END;
$function$;
