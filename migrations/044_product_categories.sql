-- ============================================================
-- 044_product_categories.sql
-- Tabela de categorias de produtos cadastraveis por empresa.
-- Produtos continuam guardando category como texto (compat), mas
-- agora ha uma entidade de primeira classe para gerenciar a lista.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,        -- hex opcional para chip (#ef4444 etc)
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS idx_product_categories_company
  ON product_categories(company_id, sort_order, name);

-- Seed: para cada company, cria categorias a partir dos produtos existentes
INSERT INTO product_categories (company_id, name, sort_order)
SELECT DISTINCT company_id, category, 0
FROM products
WHERE category IS NOT NULL
  AND TRIM(category) <> ''
ON CONFLICT (company_id, name) DO NOTHING;
