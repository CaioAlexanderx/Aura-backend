-- 218: nº CBKT (federação nacional) no histórico de faixas.
-- Identidade distinta do nº FPKT; apenas para faixas-preta. History-only
-- (não vai para a carteirinha). Idempotente.
DO $$ BEGIN
  ALTER TABLE karate_belt_history ADD COLUMN IF NOT EXISTS cbkt_number text;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
