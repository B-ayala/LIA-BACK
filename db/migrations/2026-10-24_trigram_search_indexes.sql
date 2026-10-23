-- ============================================================================
-- APLICADO 2026-10-24 — H-13 — Índices trigram para las búsquedas con ILIKE '%término%' — 2026-10-24
--
-- CONTEXTO
--  El front busca con PostgREST `ilike.%q%` (comodín al inicio, un btree no sirve):
--    productos: name, category, description  (buscador del catálogo, productService.ts)
--    ventas:    product_name, buyer_name, buyer_email  (buscador del panel de ventas)
--  Sin índice, cada tecla del buscador hace Seq Scan. Con la tabla chica no se nota;
--  el costo crece con las filas y se multiplica por usuario simultáneo.
--  Un GIN con gin_trgm_ops acelera ILIKE '%x%' y también ILIKE sin comodines
--  (el filtro de categoría `category.ilike."nombre"`).
--
-- QUÉ NO ROMPE
--  Solo agrega índices y la extensión pg_trgm (viene con Supabase). Ninguna query
--  cambia de resultado; el planner decide si usa el índice. Idempotente.
--
-- COSTO
--  Cada índice suma escritura en INSERT/UPDATE de esas columnas. `description` es
--  la columna más pesada: si el catálogo sigue chico, se puede omitir ese índice.
--  El planner ignora el índice mientras la tabla es chica: es esperado.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor. Si `ventas` ya es grande, correr cada CREATE INDEX por
--  separado con CONCURRENTLY (no admite transacción) para no bloquear escrituras.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_productos_name_trgm
  ON public.productos USING gin (name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_productos_category_trgm
  ON public.productos USING gin (category extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_productos_description_trgm
  ON public.productos USING gin (description extensions.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_ventas_product_name_trgm
  ON public.ventas USING gin (product_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ventas_buyer_name_trgm
  ON public.ventas USING gin (buyer_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ventas_buyer_email_trgm
  ON public.ventas USING gin (buyer_email extensions.gin_trgm_ops);

-- VERIFICACION (con volumen real; en tablas chicas el planner prefiere Seq Scan):
--   SET enable_seqscan = off;
--   EXPLAIN SELECT id FROM public.ventas WHERE buyer_email ILIKE '%juan%';
--   -> debe mostrar "Bitmap Index Scan on idx_ventas_buyer_email_trgm".
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS public.idx_productos_name_trgm, public.idx_productos_category_trgm,
--     public.idx_productos_description_trgm, public.idx_ventas_product_name_trgm,
--     public.idx_ventas_buyer_name_trgm, public.idx_ventas_buyer_email_trgm;
--   (la extensión pg_trgm se puede dejar instalada)
