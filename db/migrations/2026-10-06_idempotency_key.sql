-- ============================================================================
-- Idempotencia de checkout (ventas.idempotency_key) — 2026-10-06
--
-- CONTEXTO
-- Un reintento del cliente (red lenta, doble click entre pestañas, retry del
-- proxy) con la misma intención de compra no debe descontar stock dos veces.
-- El cliente manda el header `Idempotency-Key`; el backend lo persiste y, si
-- ya existe una reserva de ese (user_id, key), devuelve las órdenes previas.
--
-- DISEÑO
--  - Un carrito con N productos genera N filas en `ventas`. Para que el índice
--    UNIQUE (user_id, idempotency_key) valga por fila, cada línea guarda
--    `<key>:<huella>:<índice de línea>` (la key del cliente no admite ':').
--    `<huella>` son 12 hex de un sha256 del pedido (productos, cantidades,
--    variantes, envío y medio de pago): permite responder 422
--    IDEMPOTENCY_KEY_REUSED si la misma key llega con un carrito distinto.
--    El backend reconstruye la reserva buscando por la parte previa al primer
--    ':'. Las filas con el formato anterior `<key>:<índice>` (sin huella) se
--    siguen reconociendo y se reenvían sin comparar el contenido.
--  - Columna NULLABLE e índice PARCIAL: las filas existentes y los checkouts
--    sin header no se ven afectados.
--  - Idempotente: se puede correr más de una vez.
-- ============================================================================

ALTER TABLE public.ventas
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ventas_user_idempotency_key_uidx
  ON public.ventas (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
