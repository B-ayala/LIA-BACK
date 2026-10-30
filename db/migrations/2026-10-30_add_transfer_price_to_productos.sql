-- Precio informativo "con transferencia" que el detalle del producto muestra debajo del precio.
-- Opcional (NULL = no se muestra). No es el importe que cobra el checkout: eso sigue saliendo de `price`.
-- Idempotente.
ALTER TABLE public.productos ADD COLUMN IF NOT EXISTS transfer_price NUMERIC(10,2);
