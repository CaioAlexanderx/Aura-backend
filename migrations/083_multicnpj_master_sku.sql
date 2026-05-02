-- ============================================================
-- M-STOCKLINK MSL-01: master_sku para vincular produtos
-- entre CNPJs do mesmo owner (Multi-CNPJ).
--
-- Filosofia: "soft link" — não cria FK, não muda relacionamentos.
-- Quando dois produtos têm o mesmo master_sku, são considerados
-- "o mesmo produto em CNPJs diferentes". A view consolidada (modo
-- "Todas as empresas") soma o estoque por master_sku.
--
-- Não há restrição de unicidade global no master_sku — múltiplos
-- produtos do mesmo owner PODEM (e devem) compartilhar o mesmo
-- master_sku, é exatamente esse o ponto. Mas dentro de UMA empresa,
-- dois produtos não podem ter o mesmo master_sku (não faria sentido
-- "linkar" dois produtos da mesma empresa).
-- ============================================================

-- 1. Extensão pg_trgm pra similarity matching no MSL-02
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Coluna master_sku
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS master_sku TEXT;

-- 3. Índice por master_sku (lookup de "todos os produtos com este sku")
CREATE INDEX IF NOT EXISTS idx_products_master_sku
  ON products (master_sku)
  WHERE master_sku IS NOT NULL AND is_active = true;

-- 4. Constraint: dentro de uma empresa, master_sku é único.
--    Dois produtos da MESMA empresa não podem ter o mesmo master_sku
--    (não faz sentido linkar entre si). Parcial pra ignorar nulls
--    e produtos desativados.
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_master_sku_per_company
  ON products (company_id, master_sku)
  WHERE master_sku IS NOT NULL AND is_active = true;

-- 5. Índice trigram em name pra similarity search no MSL-02
CREATE INDEX IF NOT EXISTS idx_products_name_trgm
  ON products USING gin (name gin_trgm_ops)
  WHERE is_active = true;

-- 6. Tabela de audit pra rastrear vínculos/desvínculos
--
-- IMPORTANTE: usa uuid_generate_v4() direto (sem schema qualifier).
-- O Supabase-managed põe extensões em "extensions" mas o CI usa
-- Postgres puro com extensions no public. Mantém o mesmo padrão das
-- demais migrations do projeto (ver 001_initial_schema.sql).
CREATE TABLE IF NOT EXISTS product_link_audit (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action        TEXT NOT NULL CHECK (action IN ('link', 'unlink', 'rename_master_sku')),
  master_sku    TEXT,
  previous_master_sku TEXT,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_link_audit_user
  ON product_link_audit (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_link_audit_master_sku
  ON product_link_audit (master_sku) WHERE master_sku IS NOT NULL;

COMMENT ON COLUMN products.master_sku IS
  'Multi-CNPJ stock link: produtos com mesmo master_sku entre empresas do mesmo owner são considerados "o mesmo produto" para fins de visão consolidada. Dentro de UMA empresa, master_sku é único.';

COMMENT ON TABLE product_link_audit IS
  'Audit trail de vinculações de produtos via master_sku (Multi-CNPJ M-STOCKLINK).';
