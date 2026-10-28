-- ============================================================================
-- Registro de aceptación de términos + datos extra de arrepentimiento — 2026-10-28  (PENDIENTE de aplicar)
--
-- CONTEXTO
-- 1) Quien vende necesita poder probar qué versión de los Términos aceptó cada
--    persona y cuándo. Se guarda una fila por cada aceptación: al registrarse
--    (`registration`, sin usuario todavía), al aceptar una versión nueva (`reacceptance`)
--    y en cada compra (`checkout`, con el N° de pedido).
-- 2) El N° de pedido deja de ser obligatorio en el Botón de Arrepentimiento (quien
--    compró como invitado o perdió el mail no puede quedar sin ejercer su derecho).
--    Para encontrar la compra igual se piden, opcionales, fecha e importe.
--
-- FIX
-- a) `terms_acceptances`: user_id, buyer_email, order_number, terms_version, ip, context, accepted_at.
-- b) `withdrawal_requests.purchase_date` (date) y `purchase_amount` (numeric).
--
-- SEGURIDAD
-- `terms_acceptances` guarda email e IP (datos personales): RLS habilitada, SIN policies
-- y SIN grants para anon/authenticated. Todo pasa por la API del backend, que conecta
-- como `postgres` (mismo criterio que `withdrawal_requests`).
--
-- ORDEN DE DEPLOY
-- Aplicar este script ANTES de desplegar el backend: el insert de aceptación y el de
-- arrepentimiento usan las columnas nuevas.
--
-- CÓMO APLICAR
--  Supabase -> SQL Editor -> pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

-- ─── a) Aceptación de términos ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.terms_acceptances (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "buyer_email" text NOT NULL,
  "order_number" bigint,
  "terms_version" text NOT NULL,
  "ip" text,
  "context" text DEFAULT 'checkout' NOT NULL,
  "accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'terms_acceptances_pkey' AND conrelid = 'public.terms_acceptances'::regclass
  ) THEN
    ALTER TABLE public.terms_acceptances ADD CONSTRAINT terms_acceptances_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS terms_acceptances_order_number_idx ON public.terms_acceptances (order_number);
CREATE INDEX IF NOT EXISTS terms_acceptances_email_idx ON public.terms_acceptances (lower(buyer_email));
-- El checkout pregunta "¿esta cuenta aceptó la versión vigente?" en cada compra.
CREATE INDEX IF NOT EXISTS terms_acceptances_user_version_idx ON public.terms_acceptances (user_id, terms_version);

ALTER TABLE public.terms_acceptances DROP CONSTRAINT IF EXISTS terms_acceptances_lengths;
ALTER TABLE public.terms_acceptances ADD CONSTRAINT terms_acceptances_lengths
  CHECK (
    char_length(buyer_email) BETWEEN 3 AND 254
    AND char_length(terms_version) BETWEEN 1 AND 40
    AND (ip IS NULL OR char_length(ip) <= 64)
    AND context IN ('checkout', 'registration', 'reacceptance')
  );

ALTER TABLE public.terms_acceptances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.terms_acceptances FROM anon, authenticated;

-- ─── b) Datos extra del arrepentimiento ─────────────────────────────────────

ALTER TABLE public.withdrawal_requests ADD COLUMN IF NOT EXISTS purchase_date date;
ALTER TABLE public.withdrawal_requests ADD COLUMN IF NOT EXISTS purchase_amount numeric(12, 2);

ALTER TABLE public.withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_purchase_amount_check;
ALTER TABLE public.withdrawal_requests ADD CONSTRAINT withdrawal_requests_purchase_amount_check
  CHECK (purchase_amount IS NULL OR purchase_amount > 0);

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema = 'public' AND table_name = 'withdrawal_requests'
--    AND column_name IN ('purchase_date', 'purchase_amount');                -- debe dar 2
-- SELECT relrowsecurity FROM pg_class WHERE oid = 'public.terms_acceptances'::regclass;  -- true
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'terms_acceptances'
--    AND grantee IN ('anon', 'authenticated');                               -- debe dar 0 filas

-- ============================================================================
-- ROLLBACK (desplegar antes el backend previo)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.terms_acceptances;
--   ALTER TABLE public.withdrawal_requests DROP COLUMN IF EXISTS purchase_date;
--   ALTER TABLE public.withdrawal_requests DROP COLUMN IF EXISTS purchase_amount;
-- COMMIT;
-- NOTIFY pgrst, 'reload schema';
