-- ============================================================
-- 071 — Asaas Conta Filha: colunas na tabela companies
-- Canal Digital: cada empresa pode ter uma subconta Asaas
-- para receber pagamentos Pix diretamente
-- ============================================================

-- Colunas da subconta
ALTER TABLE companies ADD COLUMN IF NOT EXISTS
  asaas_subconta_id      VARCHAR(100);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS
  asaas_subconta_token   TEXT;

-- Status do onboarding: none | pending | active | rejected
ALTER TABLE companies ADD COLUMN IF NOT EXISTS
  asaas_subconta_status  VARCHAR(30) NOT NULL DEFAULT 'none';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS
  asaas_subconta_onboarded_at TIMESTAMPTZ;

-- Comentários documentais
COMMENT ON COLUMN companies.asaas_subconta_id     IS 'ID da Conta Filha Asaas (ex: sub_xxxxx)';
COMMENT ON COLUMN companies.asaas_subconta_token  IS 'API token da Conta Filha — usar em chamadas no nome da empresa';
COMMENT ON COLUMN companies.asaas_subconta_status IS 'none | pending | active | rejected';
