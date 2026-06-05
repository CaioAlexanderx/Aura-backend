-- 150_credit_plan_period.sql
-- Periodicidade de pagamento configurável no crediário:
-- semanal (week×1), quinzenal (week×2), mensal (month×1, default = comportamento atual)
-- e personalizado (day×N). Aplicada via Supabase MCP em 05/06/2026. Idempotente.

ALTER TABLE credit_plan_configs
  ADD COLUMN IF NOT EXISTS period_unit text NOT NULL DEFAULT 'month',
  ADD COLUMN IF NOT EXISTS period_count integer NOT NULL DEFAULT 1;

ALTER TABLE credit_plan_configs
  DROP CONSTRAINT IF EXISTS credit_plan_configs_period_unit_chk;
ALTER TABLE credit_plan_configs
  ADD CONSTRAINT credit_plan_configs_period_unit_chk CHECK (period_unit IN ('day','week','month'));
