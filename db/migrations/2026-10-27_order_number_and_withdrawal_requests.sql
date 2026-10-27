-- ============================================================================
-- Número de pedido + solicitudes de arrepentimiento — 2026-10-27  (PENDIENTE de aplicar)
--
-- CONTEXTO
-- 1) `ventas` solo se identifica por un uuid interno: el cliente no tiene un
--    número de pedido que pueda citar. Un carrito genera una fila por producto,
--    así que el número es POR COMPRA (checkout): todas las filas del mismo
--    checkout lo comparten.
-- 2) Disposición 954/2025 (Botón de Arrepentimiento): hay que registrar cada
--    solicitud y devolver un código de seguimiento en 24 h.
--
-- FIX
-- a) `ventas.order_number` (bigint, NULL en filas legacy sin backfill posible) con
--    la secuencia `ventas_order_number_seq` (arranca en 1001). Backfill: una
--    compra = mismo `mp_external_reference`; sin referencia (transferencias),
--    cada fila es su propia compra. Se numera por fecha de creación.
-- b) Tabla `withdrawal_requests` con código `ARR-AAAA-NNNN` generado por la base
--    (default sobre `withdrawal_code_seq`), sin carrera entre dos solicitudes.
--
-- SEGURIDAD
-- `withdrawal_requests` guarda datos personales: RLS habilitada, SIN policies y
-- SIN grants para anon/authenticated. Todo pasa por la API del backend, que
-- conecta como `postgres` (mismo criterio que `talles`, sección de escritura).
-- El backfill actualiza una columna que el trigger de auditoría de `ventas` no
-- vigila (solo payment_status, dispatch_status y total_price), así que no
-- inunda `audit_log`.
--
-- ORDEN DE DEPLOY
-- Aplicar este script ANTES de desplegar el backend: el checkout pide
-- `nextval('ventas_order_number_seq')` y falla si la secuencia no existe.
--
-- CÓMO APLICAR
--  Supabase -> SQL Editor -> pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

-- ─── a) Número de pedido ────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.ventas_order_number_seq START WITH 1001;

ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS order_number bigint;

-- Backfill: solo filas sin número (re-ejecutar no renumera). La numeración
-- continúa desde el máximo existente.
WITH purchases AS (
  SELECT COALESCE(mp_external_reference, id::text) AS purchase_key,
         MIN(created_at) AS first_at,
         MIN(id::text)   AS tiebreak
    FROM public.ventas
   WHERE order_number IS NULL
   GROUP BY COALESCE(mp_external_reference, id::text)
), numbered AS (
  SELECT purchase_key,
         (SELECT COALESCE(MAX(order_number), 1000) FROM public.ventas)
           + ROW_NUMBER() OVER (ORDER BY first_at, tiebreak) AS number
    FROM purchases
)
UPDATE public.ventas v
   SET order_number = numbered.number
  FROM numbered
 WHERE v.order_number IS NULL
   AND COALESCE(v.mp_external_reference, v.id::text) = numbered.purchase_key;

-- La secuencia queda en el máximo asignado: el próximo checkout toma max + 1.
SELECT setval(
  'public.ventas_order_number_seq',
  GREATEST((SELECT COALESCE(MAX(order_number), 0) FROM public.ventas), 1000),
  true
);

CREATE INDEX IF NOT EXISTS ventas_order_number_idx ON public.ventas (order_number);

-- ─── b) Solicitudes de arrepentimiento ──────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS public.withdrawal_code_seq START WITH 1;

CREATE TABLE IF NOT EXISTS public.withdrawal_requests (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "code" text DEFAULT (
    'ARR-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.withdrawal_code_seq')::text, 4, '0')
  ) NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "description" text NOT NULL,
  "order_number" bigint,
  "venta_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "status" text DEFAULT 'recibida' NOT NULL,
  "needs_review" boolean DEFAULT false NOT NULL,
  "admin_note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'withdrawal_requests_pkey' AND conrelid = 'public.withdrawal_requests'::regclass
  ) THEN
    ALTER TABLE public.withdrawal_requests ADD CONSTRAINT withdrawal_requests_pkey PRIMARY KEY (id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_requests_code_key ON public.withdrawal_requests (code);
CREATE INDEX IF NOT EXISTS withdrawal_requests_status_created_idx
  ON public.withdrawal_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS withdrawal_requests_email_idx ON public.withdrawal_requests (lower(email));

ALTER TABLE public.withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_status_check;
ALTER TABLE public.withdrawal_requests ADD CONSTRAINT withdrawal_requests_status_check
  CHECK (status IN ('recibida', 'en_gestion', 'resuelta', 'rechazada'));

ALTER TABLE public.withdrawal_requests DROP CONSTRAINT IF EXISTS withdrawal_requests_lengths;
ALTER TABLE public.withdrawal_requests ADD CONSTRAINT withdrawal_requests_lengths
  CHECK (
    char_length(btrim(name)) BETWEEN 1 AND 100
    AND char_length(email) BETWEEN 3 AND 254
    AND char_length(btrim(description)) BETWEEN 1 AND 500
    AND (admin_note IS NULL OR char_length(admin_note) <= 1000)
  );

DROP TRIGGER IF EXISTS withdrawal_requests_set_updated_at ON public.withdrawal_requests;
CREATE TRIGGER withdrawal_requests_set_updated_at
  BEFORE UPDATE ON public.withdrawal_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.withdrawal_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.withdrawal_requests FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.withdrawal_code_seq FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.ventas_order_number_seq FROM anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT order_number, count(*) FROM public.ventas GROUP BY 1 ORDER BY 1 DESC LIMIT 5;
-- SELECT count(*) FROM public.ventas WHERE order_number IS NULL;      -- debe dar 0
-- SELECT last_value FROM public.ventas_order_number_seq;              -- = max(order_number)
-- SELECT grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema = 'public' AND table_name = 'withdrawal_requests'
--    AND grantee IN ('anon', 'authenticated');                         -- debe dar 0 filas
-- INSERT INTO public.withdrawal_requests (name, email, description)
--   VALUES ('Prueba', 'prueba@example.test', 'Remera');               -- code = ARR-AAAA-0001; borrar después

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar; desplegar antes el backend previo)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.withdrawal_requests;
--   DROP SEQUENCE IF EXISTS public.withdrawal_code_seq;
--   DROP INDEX IF EXISTS public.ventas_order_number_idx;
--   ALTER TABLE public.ventas DROP COLUMN IF EXISTS order_number;
--   DROP SEQUENCE IF EXISTS public.ventas_order_number_seq;
-- COMMIT;
-- NOTIFY pgrst, 'reload schema';
