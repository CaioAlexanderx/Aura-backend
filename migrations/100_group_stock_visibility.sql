-- ============================================================
-- 100_group_stock_visibility.sql
-- Group Stock: subsidiárias vendem do catálogo da Matriz sem
-- duplicar produtos. Produtos marcados com is_group_shared=true
-- no billing_owner_company ficam visíveis para todas as
-- empresas do grupo (scan, PDV, troca).
--
-- Uso no backend (pdv.js):
--   WHERE (p.company_id = $cid
--     OR (p.company_id = c.billing_owner_company_id
--         AND p.is_group_shared = true))
-- ============================================================

-- Coluna principal: opt-in por produto
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_group_shared BOOLEAN NOT NULL DEFAULT false;

-- Índice parcial: só os produtos compartilhados são consultados
-- com o filtro de billing_owner, então a cobertura fica pequena
CREATE INDEX IF NOT EXISTS idx_products_group_shared
  ON products (company_id)
  WHERE is_group_shared = true;

COMMENT ON COLUMN products.is_group_shared IS
  'true = produto visível para todas as empresas do mesmo billing_owner_company_id. '
  'Movimentação de estoque usa company_id real do produto (stock_company_id).';
