-- ============================================================================
-- Marca de revisión de ventas (`review_reason`) — 2026-10-14
--
-- CONTEXTO
-- La conciliación con Mercado Pago (migración 2026-10-13) ya detecta situaciones
-- que requieren a un humano, pero solo las dejaba en logs:
--  - un pago aprobado cuyo monto no coincide con el total de la compra (o sin
--    monto legible): no se salda y la reserva quedaba retenida sin explicación;
--  - un segundo pago aprobado para ventas ya pagadas (posible doble cobro);
--  - un pago reembolsado o contracargado después de saldar la venta.
-- El panel de Ventas necesita ver esas ventas marcadas para actuar.
--
-- QUÉ HACE
--  1. `ventas.review_reason text NULL`. Valores que escribe el backend:
--       amount_mismatch | duplicate_payment | refunded | charged_back
--     NULL = nada que revisar. Solo DETECCIÓN: no cambia estado ni stock.
--     Sin CHECK a propósito: sumar un motivo nuevo no debe requerir otra migración
--     coordinada con el deploy; el backend es el único que escribe la columna.
--  2. Índice parcial para que el panel y el sweep encuentren rápido las marcadas.
--
-- ORDEN DE DESPLIEGUE — IMPORTANTE
--  Aplicar ESTA migración ANTES de desplegar el backend que la usa: el sweep,
--  mp-confirm y el webhook leen/escriben `review_reason`. Al arrancar, el backend
--  loguea `missing_migration` si falta la columna.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
--
-- ROLLBACK
--  BEGIN;
--    DROP INDEX IF EXISTS public.idx_ventas_review_reason;
--    ALTER TABLE public.ventas DROP COLUMN IF EXISTS review_reason;
--  COMMIT;
--  (Antes de revertir, volver al backend anterior: el actual consulta la columna.)
-- ============================================================================

BEGIN;

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS review_reason text;

CREATE INDEX IF NOT EXISTS idx_ventas_review_reason
  ON public.ventas (created_at DESC)
  WHERE review_reason IS NOT NULL;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'ventas' AND column_name = 'review_reason';
-- SELECT indexname FROM pg_indexes WHERE indexname = 'idx_ventas_review_reason';
