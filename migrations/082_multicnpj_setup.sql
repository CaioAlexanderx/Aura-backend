-- ============================================================================
-- 082_multicnpj_setup.sql — Multi-CNPJ M1-01: Fundação
-- ============================================================================
-- Adiciona suporte a múltiplos CNPJs por usuário owner.
-- Cada empresa pode ser "primary" (carrega a subscription Asaas) ou linkada
-- a uma primary via billing_owner_company_id.
--
-- Backfill: todas as empresas existentes viram primary e billing_owner = self.
-- Cenário inicial: 9 owners únicos, 9 companies, todas viram primary 1:1.
-- ============================================================================

-- 1. Coluna is_primary: marca a empresa que carrega a subscription
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;

-- 2. Coluna billing_owner_company_id: aponta pra primary do mesmo owner
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS billing_owner_company_id UUID
  REFERENCES companies(id) ON DELETE RESTRICT;

-- 3. Backfill: marcar 1ª empresa de cada owner como primary
WITH first_per_owner AS (
  SELECT DISTINCT ON (owner_id) id, owner_id
  FROM companies
  WHERE is_active = true
  ORDER BY owner_id, created_at ASC
)
UPDATE companies c
SET is_primary = true,
    billing_owner_company_id = c.id
FROM first_per_owner f
WHERE c.id = f.id;

-- 4. Backfill: empresas não-primary apontam pra primary do mesmo owner
UPDATE companies c
SET billing_owner_company_id = (
  SELECT id FROM companies p
  WHERE p.owner_id = c.owner_id AND p.is_primary = true
  LIMIT 1
)
WHERE c.is_primary = false
  AND c.billing_owner_company_id IS NULL;

-- 5. Constraint: garantir 1 primary por owner (entre empresas ativas)
CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_primary_per_owner
  ON companies(owner_id)
  WHERE is_primary = true AND is_active = true;

-- 6. Index pra lookup rápido por billing_owner
CREATE INDEX IF NOT EXISTS idx_companies_billing_owner
  ON companies(billing_owner_company_id)
  WHERE billing_owner_company_id IS NOT NULL;

-- 7. Audit log de operações multi-CNPJ
CREATE TABLE IF NOT EXISTS multicnpj_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN (
    'add_company',
    'remove_company',
    'switch_company',
    'transfer_primary',
    'update_billing'
  )),
  source_company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  target_company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_multicnpj_audit_user
  ON multicnpj_audit(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_multicnpj_audit_company
  ON multicnpj_audit(source_company_id)
  WHERE source_company_id IS NOT NULL;

-- 8. Comments pra documentação
COMMENT ON COLUMN companies.is_primary IS
  'Marca a empresa principal do owner. Apenas 1 por owner. Carrega a subscription Asaas.';
COMMENT ON COLUMN companies.billing_owner_company_id IS
  'Aponta para a company is_primary do mesmo owner. Self-reference quando is_primary=true.';
COMMENT ON TABLE multicnpj_audit IS
  'Log de operações multi-CNPJ: criação, remoção, troca de primary, switch entre empresas.';
