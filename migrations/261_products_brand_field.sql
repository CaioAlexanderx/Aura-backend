-- 261_products_brand_field
-- F0 Loja Digital v2 - Bloco A
-- Marca e ATRIBUTO, nunca no de arvore (spec v2 secao 7.7). A navegacao "Marcas"
-- da loja e faceta gerada deste campo, entrega da F3.
-- Destino de valores como 'Nike Air Force Premium' e 'Sapato Fem. Chanel', que
-- hoje poluem products.category, e do primeiro token do nome (spec v2 secao 5.3).

ALTER TABLE products ADD COLUMN IF NOT EXISTS brand text;

CREATE INDEX IF NOT EXISTS products_brand_idx ON products (company_id, brand)
  WHERE brand IS NOT NULL;
