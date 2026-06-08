-- 163: versiona schema F2/F3 do crediario (aplicado manualmente em prod) + score_warn_min (aviso, nao bloqueia)
-- Idempotente. Em prod e quase no-op (so score_warn_min + indices account_id). Em ambiente limpo reproduz o schema F2/F3.

-- credit_accounts (multiplos carnes por cliente)
CREATE TABLE IF NOT EXISTS credit_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL,
  customer_id    uuid NOT NULL,
  name           text NOT NULL,
  status         text NOT NULL DEFAULT 'open',
  terms_snapshot jsonb,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_accounts_company_customer
  ON credit_accounts (company_id, customer_id);

-- account_id nas tabelas transacionais (carne)
ALTER TABLE customer_credit_transactions ADD COLUMN IF NOT EXISTS account_id uuid;
ALTER TABLE credit_installments          ADD COLUMN IF NOT EXISTS account_id uuid;
CREATE INDEX IF NOT EXISTS idx_cct_account ON customer_credit_transactions (account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ci_account  ON credit_installments (account_id) WHERE account_id IS NOT NULL;

-- term_* por cliente (override dos termos da loja)
ALTER TABLE customer_credit_profiles ADD COLUMN IF NOT EXISTS term_interest_rate       numeric;
ALTER TABLE customer_credit_profiles ADD COLUMN IF NOT EXISTS term_max_installments    integer;
ALTER TABLE customer_credit_profiles ADD COLUMN IF NOT EXISTS term_period_unit         text;
ALTER TABLE customer_credit_profiles ADD COLUMN IF NOT EXISTS term_period_count        integer;
ALTER TABLE customer_credit_profiles ADD COLUMN IF NOT EXISTS term_due_day             integer;
ALTER TABLE customer_credit_profiles ADD COLUMN IF NOT EXISTS term_late_fee_rate       numeric;
ALTER TABLE customer_credit_profiles ADD COLUMN IF NOT EXISTS term_late_interest_daily numeric;

-- periodicidade no config da loja
ALTER TABLE credit_plan_configs ADD COLUMN IF NOT EXISTS period_unit  text;
ALTER TABLE credit_plan_configs ADD COLUMN IF NOT EXISTS period_count integer;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='credit_plan_configs_period_unit_chk') THEN
    ALTER TABLE credit_plan_configs
      ADD CONSTRAINT credit_plan_configs_period_unit_chk
      CHECK (period_unit = ANY (ARRAY['day'::text,'week'::text,'month'::text]));
  END IF;
END $$;

-- NOVO: limiar de AVISO de score (nao-impeditivo). require_score_min fica deprecado.
ALTER TABLE credit_plan_configs ADD COLUMN IF NOT EXISTS score_warn_min integer;
