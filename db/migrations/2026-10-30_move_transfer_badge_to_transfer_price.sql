-- El precio con transferencia sale solo de productos.transfer_price (la card y el detalle lo leen de ahí).
-- Antes se cargaba a mano como sello de la card ("$50.000 con transferencia") y no seguía al precio real.
-- 1) Pasa el monto del sello manual a transfer_price (solo si transfer_price está vacío).
-- 2) Saca de card_options todo sello que mencione transferencia, aunque el producto ya tuviera precio.
--    Si un producto queda sin sellos, card_options pasa a [] (no a NULL) para que no empiece a
--    mostrar los sellos globales que hoy no muestra.
-- 3) Borra los sellos globales que mencionen transferencia e impide nuevos con un CHECK
--    (product_card_options se escribe desde el front con RLS, sin pasar por el backend).
-- El patrón es el mismo que en el back (schemas/productSchema.js) y el front (utils/productCardOptions.ts):
-- "transferencia(s)", "transf." o "transf" suelto; deja pasar "transformá" o "transfiero".
--
-- ANTES de correrlo: ejecutar solo el bloque DIAGNÓSTICO y revisar las filas. Las que tengan
-- parsed_price NULL pierden el sello sin pasar el monto (texto no reconocido, ej. "10% OFF transf."):
-- cargar su precio a mano en "En transferencia ($)" después.
-- Orden de despliegue: 1) este script, 2) backend, 3) frontend.
-- Idempotente. El trigger de updated_at toca las filas migradas: un admin con el modal de edición
-- abierto en ese momento recibe "el producto cambió" al guardar. Correrlo fuera de horario de edición.

-- DIAGNÓSTICO (solo lectura)
SELECT 'producto' AS origen, p.id::text AS id, p.name, p.transfer_price, opt->>'label' AS sello,
       CASE WHEN opt->>'label' ~* '^\s*\$\s*[0-9][0-9.]*(,[0-9]{1,2})?\s+con\s+transferencia\s*$'
            THEN replace(replace(substring(opt->>'label' FROM '\$\s*([0-9][0-9.]*(?:,[0-9]{1,2})?)'), '.', ''), ',', '.')::numeric
       END AS parsed_price
FROM public.productos p
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(p.card_options) = 'array' THEN p.card_options ELSE '[]'::jsonb END) AS opt
WHERE opt->>'label' ~* '\mtransf(er[eé]ncia|\.|\M)'
UNION ALL
SELECT 'global', g.id::text, NULL, NULL, g.label, NULL
FROM public.product_card_options g
WHERE g.label ~* '\mtransf(er[eé]ncia|\.|\M)';

BEGIN;

WITH pattern AS (
  SELECT
    '\mtransf(er[eé]ncia|\.|\M)'::text AS mention,
    '^\s*\$\s*[0-9][0-9.]*(,[0-9]{1,2})?\s+con\s+transferencia\s*$'::text AS price_badge,
    '\$\s*([0-9][0-9.]*(?:,[0-9]{1,2})?)'::text AS amount
),
matches AS (
  SELECT
    p.id,
    (
      SELECT replace(replace(substring(opt->>'label' FROM pattern.amount), '.', ''), ',', '.')::numeric
      FROM jsonb_array_elements(p.card_options) AS opt
      WHERE opt->>'label' ~* pattern.price_badge
      LIMIT 1
    ) AS parsed_price,
    (
      SELECT COALESCE(jsonb_agg(e.opt ORDER BY e.ord), '[]'::jsonb)
      FROM jsonb_array_elements(p.card_options) WITH ORDINALITY AS e(opt, ord)
      WHERE COALESCE(e.opt->>'label', '') !~* pattern.mention
    ) AS remaining_options
  FROM public.productos p
  CROSS JOIN pattern
  WHERE jsonb_typeof(p.card_options) = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.card_options) AS opt
      WHERE opt->>'label' ~* pattern.mention
    )
)
UPDATE public.productos p
SET transfer_price = CASE
      WHEN p.transfer_price IS NULL AND m.parsed_price > 0 THEN m.parsed_price
      ELSE p.transfer_price
    END,
    card_options = m.remaining_options
FROM matches m
WHERE p.id = m.id;

-- Sin borrarlos, el ADD CONSTRAINT fallaría (y deshace todo) si ya existe un global así.
DELETE FROM public.product_card_options
WHERE label ~* '\mtransf(er[eé]ncia|\.|\M)';

ALTER TABLE public.product_card_options
  DROP CONSTRAINT IF EXISTS product_card_options_label_no_transfer_check;
ALTER TABLE public.product_card_options
  ADD CONSTRAINT product_card_options_label_no_transfer_check
  CHECK (label !~* '\mtransf(er[eé]ncia|\.|\M)');

COMMIT;

-- Verificación: productos con precio de transferencia y sellos que quedaron.
SELECT id, name, price, transfer_price, card_options
FROM public.productos
WHERE transfer_price IS NOT NULL
ORDER BY id;
