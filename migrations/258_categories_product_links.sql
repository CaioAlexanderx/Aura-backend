-- 258_categories_product_links
-- F0 Loja Digital v2 - Bloco A
-- Relacao N:N produto <-> categoria, com exatamente uma primaria por produto.
-- A primaria e a verdade contabil (margem por departamento sem dupla contagem);
-- as secundarias existem so para navegacao e vitrine.

CREATE TABLE IF NOT EXISTS product_category_links (
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id  uuid NOT NULL REFERENCES product_categories(id) ON DELETE CASCADE,
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, category_id)
);

-- Exatamente uma primaria por produto.
-- ATENCAO (spec 9.5): com este indice parcial, INSERT ... ON CONFLICT DO NOTHING
-- de uma primaria num produto que ja tem primaria FALHA SILENCIOSAMENTE.
-- Trocar primaria exige UPDATE ... SET is_primary = false antes do INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS product_category_links_one_primary
  ON product_category_links (product_id) WHERE is_primary;

CREATE INDEX IF NOT EXISTS product_category_links_category_idx
  ON product_category_links (category_id);

-- RLS ligada sem policy, mesmo padrao de digital_orders.
-- Isolamento multi-tenant e por WHERE company_id no backend.
ALTER TABLE product_category_links ENABLE ROW LEVEL SECURITY;
