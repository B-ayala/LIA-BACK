-- ============================================================================
-- Conciliación de pagos de Mercado Pago + endurecimiento de `ventas` — 2026-10-13
--
-- CONTEXTO
-- La auditoría de datos (DATA-001/002/003/015) encontró que:
--  - Nada guarda con qué pago de MP se saldó una venta, así que no se puede
--    conciliar ni detectar un doble cobro.
--  - El sweep y la cancelación liberan stock por tiempo, sin preguntarle a MP si
--    hay un pago en curso; un pago tardío re-descontaba con GREATEST(stock-n, 0)
--    y podía dejar una venta `pagado` sin unidad física, sin avisar a nadie.
--  - `ventas` no tiene CHECK sobre `payment_status`, `payment_method` ni
--    `dispatch_status`, y el permiso de UPDATE por columna que limita al admin a
--    `dispatch_status` existe en la base pero no en ninguna migración.
--
-- QUÉ HACE
--  1. Columnas nuevas en `ventas` (todas NULL/false por defecto: no rompe filas viejas):
--       mp_external_reference  → referencia que se le manda a MP (ids de las ventas
--                                del carrito separados por coma). El backend la usa
--                                para buscar pagos en MP antes de liberar stock.
--       mp_payment_id          → id del pago de MP que saldó la venta.
--       oversold               → true si el pago llegó cuando ya no había stock: hay
--                                que reembolsar o conseguir la mercadería.
--     (`mp_preference_id` ya existe; el backend ahora sí la escribe.)
--  2. Índices parciales para las búsquedas del sweep y del panel.
--  3. CHECK de estados (NOT VALID + VALIDATE: falla si hay filas con valores raros).
--  4. Permiso de UPDATE por columna sobre `ventas` (reproduce el estado real de la base).
--  5. `search_path` fijo en la función SECURITY DEFINER del trigger de stock.
--
-- ORDEN DE DESPLIEGUE — IMPORTANTE
--  Aplicar ESTA migración ANTES de desplegar el backend que la usa. El backend
--  nuevo escribe `mp_payment_id` y `oversold` al confirmar pagos: sin las
--  columnas, confirmar un pago fallaría. Al arrancar, el backend avisa con un
--  `missing_migration` en los logs si faltan.
--
-- NO INCLUYE (decisiones pendientes)
--  - Baseline de `CREATE TABLE ventas/productos` y del trigger: requiere `pg_dump
--    --schema-only` de la base real.
--  - `productos.stock NOT NULL`: el front trata stock NULL como "sin control de stock".
--  - La columna huérfana `ventas.idempotency_key` (no la usa ningún código).
--  - Índices de rendimiento: ya están en 2026-08-08_add_performance_indexes.sql
--    (idempotente) pero NO estaban aplicados en la base: correr ese archivo también.
--
-- ROLLBACK
--  ALTER TABLE public.ventas
--    DROP CONSTRAINT IF EXISTS ventas_payment_status_check,
--    DROP CONSTRAINT IF EXISTS ventas_payment_method_check,
--    DROP CONSTRAINT IF EXISTS ventas_dispatch_status_check,
--    DROP COLUMN IF EXISTS mp_external_reference,
--    DROP COLUMN IF EXISTS mp_payment_id,
--    DROP COLUMN IF EXISTS oversold;
--  (los permisos de columna y el search_path pueden quedar: son el estado deseado)
-- ============================================================================

BEGIN;

-- 1. Columnas de conciliación ------------------------------------------------
ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS mp_external_reference text,
  ADD COLUMN IF NOT EXISTS mp_payment_id         text,
  ADD COLUMN IF NOT EXISTS oversold              boolean NOT NULL DEFAULT false;

-- 2. Índices parciales -------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ventas_mp_external_reference
  ON public.ventas (mp_external_reference)
  WHERE mp_external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_mp_payment_id
  ON public.ventas (mp_payment_id)
  WHERE mp_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_oversold
  ON public.ventas (created_at DESC)
  WHERE oversold;

-- 3. CHECK de estados --------------------------------------------------------
-- `fallido` no se incluye: el backend nunca lo escribe (ver DATA-011).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ventas_payment_status_check') THEN
    ALTER TABLE public.ventas ADD CONSTRAINT ventas_payment_status_check
      CHECK (payment_status IN ('pendiente', 'pagado', 'cancelado', 'expirado')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ventas_payment_method_check') THEN
    ALTER TABLE public.ventas ADD CONSTRAINT ventas_payment_method_check
      CHECK (payment_method IN ('mp', 'transfer')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ventas_dispatch_status_check') THEN
    ALTER TABLE public.ventas ADD CONSTRAINT ventas_dispatch_status_check
      CHECK (dispatch_status IN ('pendiente', 'en_preparacion', 'despachado', 'listo_para_retiro', 'entregado')) NOT VALID;
  END IF;
END
$$;

ALTER TABLE public.ventas VALIDATE CONSTRAINT ventas_payment_status_check;
ALTER TABLE public.ventas VALIDATE CONSTRAINT ventas_payment_method_check;
ALTER TABLE public.ventas VALIDATE CONSTRAINT ventas_dispatch_status_check;

-- 4. UPDATE por columna (el admin solo cambia el despacho desde el navegador) --
-- `payment_status` lo cambia únicamente el backend, que arrastra la lógica de stock.
REVOKE UPDATE ON public.ventas FROM anon, authenticated;
GRANT UPDATE (dispatch_status) ON public.ventas TO authenticated;

-- 5. search_path fijo en la función SECURITY DEFINER del trigger de stock ------
ALTER FUNCTION public.decrement_stock_on_sale() SET search_path = public;

COMMIT;
