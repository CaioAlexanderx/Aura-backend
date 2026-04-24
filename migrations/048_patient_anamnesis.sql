-- ============================================================
-- AURA. — Migration 048: anamnese odontologica em customers (D-UNIFY)
--
-- Aplicada em producao via MCP Supabase em 24/04/2026.
-- Arquivo espelho criado conforme regra de migration da sessao.
--
-- Armazena anamnese como JSONB na tabela customers quando
-- is_patient=true. Mantem retrocompat com o padrao D-UNIFY
-- (nao cria tabela separada). LGPD Art.11 aplicavel.
-- ============================================================

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS anamnesis_data jsonb,
  ADD COLUMN IF NOT EXISTS anamnesis_updated_at timestamptz;

-- Index parcial: otimiza queries de "pacientes com anamnese recente"
-- e "pacientes sem anamnese" (anamnesis_updated_at IS NULL).
CREATE INDEX IF NOT EXISTS idx_customers_anamnesis_updated
  ON customers(company_id, anamnesis_updated_at DESC NULLS LAST)
  WHERE is_patient = true;

COMMENT ON COLUMN customers.anamnesis_data IS
  'Anamnese odontologica (LGPD Art.11). JSONB: doencas[], alergias[], medicacoes[], habitos (tabagismo/bruxismo/sangramento), gravidez, cirurgia_recente, observacoes, lgpd_consent. Apenas quando is_patient=true.';
COMMENT ON COLUMN customers.anamnesis_updated_at IS
  'Timestamp da ultima atualizacao da anamnese. Ajuda a identificar anamneses desatualizadas (>12 meses).';
