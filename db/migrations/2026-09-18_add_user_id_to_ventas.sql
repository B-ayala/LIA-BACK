-- ============================================================================
-- FK real de comprador en ventas (ventas.user_id) — 2026-09-18
--
-- CONTEXTO
-- Hallazgo H-005 de la auditoría de usuarios/ventas: `ventas` identificaba al
-- comprador solo por `buyer_email`/`buyer_name` en texto libre, sin FK a
-- `auth.users`. Eso rompe "Mis compras" si el usuario cambia de email, y hace
-- que cualquier ranking de clientes tenga que agrupar por email (no confiable)
-- en vez de por persona real.
--
-- Se agrega `user_id` como referencia real. `buyer_name`/`buyer_email` se
-- conservan tal cual: son el snapshot histórico del comprador al momento de la
-- compra (correcto conservarlos aunque el usuario cambie el email después).
--
-- QUÉ NO ROMPE
--  - Columna nueva NULLABLE: ninguna fila existente ni query existente cambia
--    de comportamiento. `getUserOrders`/`Order.findPaidByEmail` siguen
--    filtrando por email como antes; `user_id` es un dato adicional, no un
--    reemplazo (todavía).
--  - `ON DELETE SET NULL`: si se borra la cuenta de un comprador (ver
--    `models/User.js` `findByIdAndDelete`), sus ventas pasadas no se borran en
--    cascada, solo pierden el vínculo (igual que hoy, que no tienen ninguno).
--  - No toca RLS: `ventas_update_admin`/`ventas_select_admin` son a nivel de
--    tabla, cubren la columna nueva automáticamente.
--
-- CÓMO SE PUEBLA A PARTIR DE AHORA
--  El backend guarda `user_id` al crear la orden (`reserveOrders` en
--  `controllers/orderController.js`, con `req.user.id` del checkout
--  autenticado). El backfill de abajo solo cubre las filas que ya existían.
--
-- CÓMO APLICAR
--  Supabase → SQL Editor → pegar y ejecutar. Es idempotente y transaccional.
-- ============================================================================

BEGIN;

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ventas_user_id ON public.ventas (user_id);

-- Backfill best-effort de filas históricas: matchea por email exacto
-- (case-insensitive) contra auth.users. Filas cuyo buyer_email no matchea
-- ninguna cuenta (compra de invitado, cuenta borrada, typo) quedan con
-- user_id NULL a propósito: no se inventa un vínculo que no existe.
UPDATE public.ventas v
SET user_id = u.id
FROM auth.users u
WHERE v.user_id IS NULL
  AND v.buyer_email IS NOT NULL
  AND LOWER(u.email) = LOWER(v.buyer_email);

COMMIT;

-- ============================================================================
-- VERIFICACIÓN (ejecutar después)
-- ============================================================================
-- SELECT count(*) AS total, count(user_id) AS con_user_id FROM public.ventas;
-- SELECT id, buyer_email, user_id FROM public.ventas WHERE user_id IS NULL;

-- ============================================================================
-- ROLLBACK (solo si algo dejara de funcionar)
-- ============================================================================
-- BEGIN;
--   DROP INDEX IF EXISTS public.idx_ventas_user_id;
--   ALTER TABLE public.ventas DROP COLUMN IF EXISTS user_id;
-- COMMIT;
