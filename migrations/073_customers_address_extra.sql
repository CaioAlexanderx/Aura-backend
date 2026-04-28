-- ============================================================
-- 073_customers_address_extra.sql
--
-- PR22 (2026-04-28): adiciona 4 colunas de endereco em customers
-- pra suportar cadastro completo de paciente para emissao de NF-e.
--
-- customers ja tinha: street, complement, city, state.
-- Faltavam: phone secundario, numero, bairro, CEP.
--
-- Idempotente (IF NOT EXISTS).
-- ============================================================

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_secondary text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address_number text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS neighborhood text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal_code text;

COMMENT ON COLUMN customers.phone_secondary IS 'Telefone secundario do cliente/paciente (PR22 — dados completos para NF-e)';
COMMENT ON COLUMN customers.address_number IS 'Numero do logradouro (PR22 — endereco para NF-e)';
COMMENT ON COLUMN customers.neighborhood IS 'Bairro (PR22 — endereco para NF-e)';
COMMENT ON COLUMN customers.postal_code IS 'CEP, apenas digitos (PR22 — endereco para NF-e)';
