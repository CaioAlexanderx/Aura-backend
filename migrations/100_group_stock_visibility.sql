-- ============================================================
-- Migration 100: Group Stock Visibility (Multi-CNPJ)
-- Permite que produtos de uma empresa primária (billing_owner)
-- sejam visíveis para CNPJs vinculados do mesmo grupo.
-- PDV e cancelamentos usam o company_id real do produto para
-- mover estoque — sem pool compartilhado, apenas visibilidade.
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_group_shared BOOLEAN NOT NULL DEFAULT false;

-- Índice parcial: só produtos marked como shared (lista pequena)
CREATE INDEX IF NOT EXISTS idx_products_group_shared
  ON products (company_id)
  WHERE is_group_shared = true;

COMMENT ON COLUMN products.is_group_shared IS
  'Quando true, produto visível para todos CNPJs cujo billing_owner_company_id aponte para este company_id.';
