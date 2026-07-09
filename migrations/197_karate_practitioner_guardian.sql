-- migration 197: Responsável do praticante (LGPD) — P7
-- Renumerada de 195 (colidia com 195_fix_davi_variant_duplicates.sql; 196 também ocupado).
-- Convenção CLAUDE.md: numeração sequencial, incrementar se o número já existe.
-- Idempotente via IF NOT EXISTS. As colunas já foram aplicadas em prod via Supabase MCP.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS guardian_name         text,
  ADD COLUMN IF NOT EXISTS guardian_cpf          text,
  ADD COLUMN IF NOT EXISTS guardian_phone        text,
  ADD COLUMN IF NOT EXISTS guardian_relationship text;

COMMENT ON COLUMN customers.guardian_name         IS 'Nome completo do responsável legal (LGPD — menores)';
COMMENT ON COLUMN customers.guardian_cpf          IS 'CPF do responsável legal';
COMMENT ON COLUMN customers.guardian_phone        IS 'Telefone/WhatsApp do responsável legal';
COMMENT ON COLUMN customers.guardian_relationship IS 'Grau de parentesco (ex.: mãe, pai, avó)';
