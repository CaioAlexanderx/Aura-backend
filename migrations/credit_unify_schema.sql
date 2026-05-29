-- credit_unify_schema
-- Prepara tabelas de crediário para modelo de cobertura FIFO (creditLedger.js).
-- Idempotente: usa IF NOT EXISTS em todas as alterações DDL.
-- credit_plan_configs.interest_rate já existe — sem alterar.
-- 29/05/2026

-- 1. credit_installments: covered_amount substitui amount_paid como verdade da cobertura FIFO
ALTER TABLE credit_installments
  ADD COLUMN IF NOT EXISTS covered_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN credit_installments.covered_amount
  IS 'Cobertura FIFO alocada pelo applyPayment. Parcela paga quando covered_amount >= amount_due.';

-- 2. customer_credit_transactions: idempotency_key para payment idempotente
ALTER TABLE customer_credit_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cct_idempotency_key
  ON customer_credit_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- 3. Indice composto para FIFO e aging em credit_installments
CREATE INDEX IF NOT EXISTS idx_ci_fifo
  ON credit_installments (company_id, customer_id, status, due_date);
