-- ============================================================
-- AURA. — Migration 094: NFC-e — links de XML/PDF
--
-- Após a reescrita do payload da Nuvem Fiscal (schema infNFe),
-- a resposta de autorização traz link_xml/link_pdf que queremos
-- persistir para o front linkar direto. Antes só guardávamos
-- chave_acesso + protocolo, e o usuário não tinha o DANFE.
--
-- Idempotente.
-- ============================================================

ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS xml_url text,
  ADD COLUMN IF NOT EXISTS pdf_url text;

CREATE INDEX IF NOT EXISTS idx_nfce_emissions_company_status
  ON nfce_emissions(company_id, status);

CREATE INDEX IF NOT EXISTS idx_nfce_emissions_company_created
  ON nfce_emissions(company_id, created_at DESC);
