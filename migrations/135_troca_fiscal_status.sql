-- Adiciona controle de retry/erro em nfce_emissions e tabela de idempotencia de troca

ALTER TABLE nfce_emissions ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE nfce_emissions ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0;
ALTER TABLE nfce_emissions ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_nfce_emissions_pendentes
  ON nfce_emissions (status, next_retry_at) WHERE status = 'pendente';

CREATE TABLE IF NOT EXISTS troca_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  company_id UUID NOT NULL,
  troca_sale_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
