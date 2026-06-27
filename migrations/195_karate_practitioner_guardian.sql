-- migration 195: Responsável do praticante (LGPD) — P7
-- Adiciona campos de responsável/tutor legal em customers.
-- Idempotente via IF NOT EXISTS (Postgres 9.6+).
-- NÃO aplicar automaticamente — apply manual após review.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS guardian_name         text,
  ADD COLUMN IF NOT EXISTS guardian_cpf          text,
  ADD COLUMN IF NOT EXISTS guardian_phone        text,
  ADD COLUMN IF NOT EXISTS guardian_relationship text;

COMMENT ON COLUMN customers.guardian_name         IS 'Nome completo do responsável legal (LGPD — menores)';
COMMENT ON COLUMN customers.guardian_cpf          IS 'CPF do responsável legal';
COMMENT ON COLUMN customers.guardian_phone        IS 'Telefone/WhatsApp do responsável legal';
COMMENT ON COLUMN customers.guardian_relationship IS 'Grau de parentesco (ex.: mãe, pai, avó)';
