-- ============================================================
-- AURA. — Migration 090: NFCe PDV — Integração Nuvem Fiscal
-- Adiciona rastreamento do ID do provedor fiscal, log de erros
-- e tipo de documento (nfce | nfe) em nfce_emissions
-- Idempotente: usa IF NOT EXISTS em todas as operações
-- ============================================================

ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS nuvemfiscal_id  VARCHAR(100),
  ADD COLUMN IF NOT EXISTS error_message   TEXT,
  ADD COLUMN IF NOT EXISTS tipo            VARCHAR(10) NOT NULL DEFAULT 'nfce';

CREATE INDEX IF NOT EXISTS idx_nfce_emissions_nuvemfiscal_id
  ON nfce_emissions(nuvemfiscal_id)
  WHERE nuvemfiscal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_nfce_emissions_tipo
  ON nfce_emissions(company_id, tipo);
