-- ============================================================================
-- Toggle de imagen secundaria en hover — 2026-09-28
--
-- CONTEXTO
-- Las cards de producto muestran la segunda imagen (con zoom) al pasar el
-- mouse. El negocio pidió poder desactivar ese efecto por producto desde el
-- admin (crear/editar producto), quedando activado por defecto.
--
-- FIX
-- Columna `hover_image_enabled` en `productos`, boolean NOT NULL DEFAULT true.
-- Los productos existentes quedan con el comportamiento actual (activado).
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

ALTER TABLE public.productos
  ADD COLUMN IF NOT EXISTS hover_image_enabled boolean NOT NULL DEFAULT true;

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT id, name, hover_image_enabled FROM public.productos LIMIT 10;

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   ALTER TABLE public.productos DROP COLUMN IF EXISTS hover_image_enabled;
-- COMMIT;
