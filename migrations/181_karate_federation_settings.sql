-- ============================================================
-- AURA KARATÊ — Migration 181: Configurações da Federação (Track H)
--
-- Adiciona colunas de identidade fiscal à tabela companies, necessárias
-- para a seção "Dados fiscais" (emissão NFS-e de anuidades).
--
-- Colunas NOVAS (não existem ainda):
--   companies.inscricao_municipal  TEXT  — inscrição municipal da federação
--   companies.regime_tributario    TEXT  — Simples Nacional / Lucro Presumido / Imune
--
-- Colunas que JÁ EXISTEM (verificadas nos migrations anteriores):
--   companies.name                 → nome / razão social
--   companies.cnpj                 → CNPJ
--   companies.wa_phone_display     → WhatsApp exibição
--   companies.slug                 → slug público
--   companies.karate_logo_url      → logo (adicionado no setup do Track A)
--   companies.module_overrides     → JSONB feature flags (já existente)
--
-- Defensivo: IF NOT EXISTS em todos os ADD COLUMN.
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS inscricao_municipal  TEXT,
  ADD COLUMN IF NOT EXISTS regime_tributario    TEXT
    CHECK (regime_tributario IS NULL OR regime_tributario IN
      ('simples_nacional','lucro_presumido','imune_isenta'));

COMMENT ON COLUMN companies.inscricao_municipal IS
  'Inscrição municipal da federação — usado para emissão de NFS-e de anuidades (Track P)';
COMMENT ON COLUMN companies.regime_tributario IS
  'Regime tributário: simples_nacional | lucro_presumido | imune_isenta';

-- FIM DA MIGRATION 181
