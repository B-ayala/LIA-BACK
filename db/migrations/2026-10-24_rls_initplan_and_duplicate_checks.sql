-- ============================================================================
-- APLICADO 2026-10-24 — H-12 + H-08 — Policies con (SELECT auth.uid()) y CHECKs duplicados — 2026-10-24
--
-- H-12 CONTEXTO
--  Una policy con `auth.uid()` a secas lo reevalúa POR CADA FILA. Envuelto como
--  `(SELECT auth.uid())` Postgres lo calcula una sola vez por query (InitPlan).
--  En listados de ventas/productos leídos por PostgREST el ahorro crece con las filas.
--  El script reescribe, en el esquema `public`, toda policy cuyo USING / WITH CHECK
--  contenga `auth.uid()` sin envolver. Solo cambia la expresión: rol, comando y
--  semántica quedan IGUAL. Se hace dinámico porque los nombres de policy en la base
--  real difieren de los scripts históricos.
--
-- H-08 CONTEXTO
--  `ventas` tiene dos CHECK sobre payment_status:
--    ventas_payment_status_check  (pendiente|pagado|cancelado|expirado)   -- validado
--    ventas_payment_status_domain (los anteriores + 'fallido')             -- redundante
--  Gana siempre el más estricto, así que `_domain` no aporta y confunde (el backend
--  nunca escribe 'fallido', ver DATA-011). Se elimina. Además se validan los CHECK
--  NOT VALID de 2026-10-13 solo si no hay filas que los violen.
--
-- H-09: N/A. `ventas.idempotency_key` y su UNIQUE parcial ya existen
--  (2026-10-06_idempotency_key.sql).
--
-- Idempotente. Todo en una transacción: si algo falla, no queda nada a medias.
-- ============================================================================
BEGIN;

-- H-12 ------------------------------------------------------------------------
DO $$
DECLARE
  pol record;
  new_using text;
  new_check text;
  stmt text;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (qual ~ 'auth\.uid\(\)' OR with_check ~ 'auth\.uid\(\)')
  LOOP
    -- Postgres guarda una policy ya envuelta como "( SELECT auth.uid() AS uid)":
    -- se enmascara para no envolver dos veces (idempotencia).
    new_using := regexp_replace(pol.qual, '\(\s*SELECT\s+auth\.uid\(\)[^)]*\)', '#WRAPPED#', 'gi');
    new_using := replace(new_using, 'auth.uid()', '(SELECT auth.uid())');
    new_using := replace(new_using, '#WRAPPED#', '(SELECT auth.uid())');
    new_check := regexp_replace(pol.with_check, '\(\s*SELECT\s+auth\.uid\(\)[^)]*\)', '#WRAPPED#', 'gi');
    new_check := replace(new_check, 'auth.uid()', '(SELECT auth.uid())');
    new_check := replace(new_check, '#WRAPPED#', '(SELECT auth.uid())');

    IF new_using IS NOT DISTINCT FROM pol.qual AND new_check IS NOT DISTINCT FROM pol.with_check THEN
      CONTINUE;
    END IF;

    stmt := format('ALTER POLICY %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    IF pol.qual IS NOT NULL THEN
      stmt := stmt || format(' USING (%s)', new_using);
    END IF;
    IF pol.with_check IS NOT NULL THEN
      stmt := stmt || format(' WITH CHECK (%s)', new_check);
    END IF;
    EXECUTE stmt;
    RAISE NOTICE 'policy reescrita: %.%', pol.tablename, pol.policyname;
  END LOOP;
END
$$;

-- H-08 ------------------------------------------------------------------------
ALTER TABLE public.ventas DROP CONSTRAINT IF EXISTS ventas_payment_status_domain;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ventas WHERE quantity <= 0 OR unit_price < 0 OR total_price < 0) THEN
    ALTER TABLE public.ventas VALIDATE CONSTRAINT ventas_amounts_sane;
  ELSE
    RAISE NOTICE 'ventas_amounts_sane NO validado: hay filas que lo violan (revisar a mano)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.productos
     WHERE price < 0 OR (discount IS NOT NULL AND (discount < 0 OR discount > 100))
  ) THEN
    ALTER TABLE public.productos VALIDATE CONSTRAINT productos_price_sane;
  ELSE
    RAISE NOTICE 'productos_price_sane NO validado: hay filas que lo violan (revisar a mano)';
  END IF;
END
$$;

COMMIT;

-- VERIFICACION:
--   -- ninguna policy debe quedar con auth.uid() sin envolver (0 filas):
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public'
--      AND (qual ~ 'auth\.uid\(\)' AND qual !~ 'SELECT auth\.uid\(\)'
--        OR with_check ~ 'auth\.uid\(\)' AND with_check !~ 'SELECT auth\.uid\(\)');
--   -- CHECKs de ventas / productos y si están validados:
--   SELECT conrelid::regclass, conname, convalidated FROM pg_constraint
--    WHERE contype = 'c' AND conrelid IN ('public.ventas'::regclass, 'public.productos'::regclass);
--   -- Probar con la cuenta de prueba: catálogo público, "Mis compras" y panel admin cargan igual.
--
-- ROLLBACK:
--   H-12: sin impacto funcional; si hiciera falta, ALTER POLICY con la expresión original.
--   H-08: ALTER TABLE public.ventas ADD CONSTRAINT ventas_payment_status_domain
--           CHECK (payment_status IN ('pendiente','pagado','cancelado','expirado','fallido')) NOT VALID;
