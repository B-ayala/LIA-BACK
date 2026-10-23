-- ============================================================================
-- Sellos de la card por producto (card_options) — 2026-10-23
--
-- CONTEXTO
-- Las cards de producto muestran sellos (ej. "Envío gratis") tomados de las
-- opciones globales (tabla product_card_options). El negocio pidió poder
-- definir sellos propios por producto desde el admin.
--
-- CAMBIO
-- Columna `card_options` en `productos`, jsonb NULL.
--   NULL   -> el producto usa las opciones globales (comportamiento actual).
--   []     -> sin sellos.
--   [ {label, icon, isActive}, ... ] -> sellos propios, en orden de display.
-- Los productos existentes quedan en NULL (sin cambios visibles).
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS card_options jsonb NULL;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT id, name, card_options FROM public.productos LIMIT 10;

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.productos DROP COLUMN IF EXISTS card_options;
-- COMMIT;
