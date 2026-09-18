-- ============================================================================
-- Opciones configurables de la card de producto — 2026-09-18
--
-- CONTEXTO
-- Las cards de producto de los listados mostraban los círculos de color de la
-- variante "Color". El negocio pidió sacarlos de ahí (quedan intactos en el
-- detalle del producto) y en su lugar poder configurar, sin tocar código,
-- qué "sellos" mostrar abajo de cada card (Mercado Pago, tarjetas, envío
-- gratis, cuotas, retiro en el local, etc.).
--
-- FIX
-- Tabla `product_card_options`: una fila por opción, con label + ícono
-- (nombre de ícono de lucide-react, resuelto en el front) + orden + activo.
-- El front público solo lee las activas; el admin gestiona todas (alta, baja,
-- edición, activar/desactivar, reordenar) desde el panel.
--
-- SEGURIDAD
-- Mismo patrón que `carousel_images` (2026-08-09_rls_hardening.sql): lectura
-- pública (anon + authenticated), escritura solo admin vía public.is_admin().
-- Los GRANT por defecto del esquema public ya cubren INSERT/UPDATE/DELETE
-- para anon/authenticated; RLS es la que efectivamente bloquea a no-admins.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.product_card_options (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "label" text NOT NULL,
  "icon" text NOT NULL,
  "order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.product_card_options ADD CONSTRAINT product_card_options_pkey PRIMARY KEY (id);
ALTER TABLE public.product_card_options ADD CONSTRAINT product_card_options_label_check CHECK (char_length(btrim(label)) > 0);
ALTER TABLE public.product_card_options ADD CONSTRAINT product_card_options_icon_check CHECK (char_length(btrim(icon)) > 0);

DROP TRIGGER IF EXISTS product_card_options_set_updated_at ON public.product_card_options;
CREATE TRIGGER product_card_options_set_updated_at
  BEFORE UPDATE ON public.product_card_options
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.product_card_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_card_options_select_public ON public.product_card_options;
CREATE POLICY product_card_options_select_public ON public.product_card_options
  AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS product_card_options_insert_admin ON public.product_card_options;
CREATE POLICY product_card_options_insert_admin ON public.product_card_options
  AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (is_admin());

DROP POLICY IF EXISTS product_card_options_update_admin ON public.product_card_options;
CREATE POLICY product_card_options_update_admin ON public.product_card_options
  AS PERMISSIVE FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS product_card_options_delete_admin ON public.product_card_options;
CREATE POLICY product_card_options_delete_admin ON public.product_card_options
  AS PERMISSIVE FOR DELETE TO authenticated USING (is_admin());

COMMIT;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- SELECT * FROM public.product_card_options ORDER BY "order";
-- SELECT policyname, roles, cmd, qual FROM pg_policies
--  WHERE schemaname = 'public' AND tablename = 'product_card_options';

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   DROP TABLE IF EXISTS public.product_card_options;
-- COMMIT;
