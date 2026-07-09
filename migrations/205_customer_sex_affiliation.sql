-- Migration 205: colunas para ficha de praticante (Aura Karatê) — sexo e
-- data de filiação. Idempotente (ADD COLUMN IF NOT EXISTS + guarda de
-- constraint via DO $$ ... EXCEPTION). Backend não roda migrations no boot
-- (CLAUDE.md): rotas que usam estas colunas tratam 42703 defensivamente até
-- esta migration ser aplicada via Supabase MCP.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS sex text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS affiliation_since date;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_sex_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_sex_check
      CHECK (sex IS NULL OR sex IN ('masculino', 'feminino', 'outro'));
  END IF;
END $$;
