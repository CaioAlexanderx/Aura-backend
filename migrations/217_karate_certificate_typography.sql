-- 217: tipografia dos modelos de certificado (fonte + escala/auto-fit de texto).
-- Idempotente. Colunas novas com defaults compatíveis com o comportamento atual.
DO $$ BEGIN
  ALTER TABLE karate_certificate_templates ADD COLUMN IF NOT EXISTS font text NOT NULL DEFAULT 'classica';
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE karate_certificate_templates ADD COLUMN IF NOT EXISTS text_scale numeric;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE karate_certificate_templates ADD COLUMN IF NOT EXISTS auto_fit boolean NOT NULL DEFAULT false;
EXCEPTION WHEN undefined_table THEN NULL; END $$;
