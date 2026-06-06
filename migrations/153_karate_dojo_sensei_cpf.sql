-- ============================================================
-- AURA KARATÊ — Migration 153: Coluna sensei_cpf em companies
-- Dojôs informais (sem CNPJ) são representados pelo CPF do
-- sensei responsável. Campo opcional — coexiste com cnpj.
-- Referência contratual: DojoInput.sensei_cpf (OpenAPI Phase 0)
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS sensei_cpf TEXT;

-- ============================================================
-- FIM DA MIGRATION 153
-- ============================================================
