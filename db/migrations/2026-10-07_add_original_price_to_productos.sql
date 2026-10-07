-- Precio de lista tachado de un producto en promoción. `price` sigue siendo el precio final.
-- Idempotente: en la base actual la columna ya existe.
ALTER TABLE public.productos ADD COLUMN IF NOT EXISTS original_price NUMERIC(10,2);
