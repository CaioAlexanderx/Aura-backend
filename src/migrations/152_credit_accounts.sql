-- 152_credit_accounts.sql
-- F3: multiplos carnes (credit_accounts) por cliente
-- Linhas legadas ficam com account_id NULL = "Conta geral" (sem backfill destrutivo)

CREATE TABLE IF NOT EXISTS credit_accounts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL,
  customer_id uuid        NOT NULL,
  name        text        NOT NULL,
  status      text        NOT NULL DEFAULT 'open',
  terms_snapshot jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_company_customer
  ON credit_accounts (company_id, customer_id);

ALTER TABLE customer_credit_transactions
  ADD COLUMN IF NOT EXISTS account_id uuid;

ALTER TABLE credit_installments
  ADD COLUMN IF NOT EXISTS account_id uuid;
