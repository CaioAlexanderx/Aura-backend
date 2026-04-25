-- ============================================================
-- AURA. — GAP-03: Estoque de Materiais Odontológicos
-- Aplicada em producao via MCP Supabase em 25/04/2026.
-- Arquivo espelho criado conforme regra de migration da sessao.
--
-- Estratégia: extende products com 4 colunas específicas.
-- Reutiliza: stock_movements, stock_qty, stock_min, supplier_name.
-- Zero tabela nova — filtro por is_dental_supply = true.
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_dental_supply  boolean     DEFAULT false,
  ADD COLUMN IF NOT EXISTS dental_category   varchar(30),
  ADD COLUMN IF NOT EXISTS expiry_date       date,
  ADD COLUMN IF NOT EXISTS lot_number        varchar(60);

-- Index para consultas rapidas da aba Materiais
CREATE INDEX IF NOT EXISTS idx_products_dental_supply
  ON products(company_id, is_dental_supply, is_active)
  WHERE is_dental_supply = true;

-- Index de validade (alertas de vencimento)
CREATE INDEX IF NOT EXISTS idx_products_expiry
  ON products(company_id, expiry_date)
  WHERE is_dental_supply = true AND expiry_date IS NOT NULL;
