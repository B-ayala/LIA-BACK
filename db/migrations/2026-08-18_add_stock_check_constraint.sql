-- ============================================================================
-- CHECK (stock >= 0) en productos — 2026-08-18
--
-- CONTEXTO
-- El mecanismo real que evita sobreventa es el `SELECT ... FOR UPDATE` +
-- transacción en `reserveOrders` (orderController.js) y `markPaidByIds`
-- (models/Order.js): serializan las compras concurrentes del mismo producto
-- y ninguno de los `UPDATE stock` de la aplicación puede dejarlo negativo
-- (todos usan `GREATEST(stock - qty, 0)`, trigger `trg_decrement_stock`
-- incluido). Ese lock es correcto y no se toca en esta migración.
--
-- Esta constraint es una segunda barrera, no el mecanismo principal: si en el
-- futuro algún código (script manual, migración de datos, función nueva)
-- escribe `stock` sin pasar por ese flujo y sin el `GREATEST`, Postgres
-- rechaza el `UPDATE`/`INSERT` en vez de dejar un stock negativo silencioso.
--
-- QUÉ NO ROMPE
--  - No cambia el flujo de compra ni el trigger: solo agrega una restricción
--    que hoy ningún camino de escritura existente puede violar.
--  - `GREATEST(stock - qty, 0)` en el trigger y en `markPaidByIds` sigue
--    clampeando a 0 antes de llegar a la constraint.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
--  El pre-chequeo aborta la migración si hoy ya existiera stock negativo
--  (no debería, pero así falla explícito en vez de silencioso).
-- ============================================================================

DO $$
DECLARE negative_count integer;
BEGIN
  SELECT count(*) INTO negative_count FROM public.productos WHERE stock < 0;
  IF negative_count > 0 THEN
    RAISE EXCEPTION 'Hay % producto(s) con stock negativo: corregir antes de agregar la constraint', negative_count;
  END IF;
END $$;

BEGIN;

ALTER TABLE public.productos DROP CONSTRAINT IF EXISTS productos_stock_non_negative;
ALTER TABLE public.productos ADD CONSTRAINT productos_stock_non_negative CHECK (stock >= 0);

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (ejecutar después; debe listar la constraint)
-- ============================================================================
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid = 'public.productos'::regclass AND conname = 'productos_stock_non_negative';

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- ALTER TABLE public.productos DROP CONSTRAINT IF EXISTS productos_stock_non_negative;
