-- ============================================================
-- 099_customer_credit.sql
-- Crediario (fiado) por cliente — modelo "medio":
--   - cliente OBRIGATORIO ao vender no crediario
--   - registra dividas e pagamentos em tabela propria
--   - NAO integra com Financeiro/contas a receber existentes
--
-- Modelo de transacoes: cada venda no crediario gera 'debit',
-- cada pagamento avulso gera 'payment'. Saldo devedor =
-- SUM(debit) - SUM(payment), exposto via view.
--
-- Multi-CNPJ: saldo e por (customer_id, company_id) — um mesmo
-- cliente pode ter saldo em CNPJs diferentes do mesmo dono.
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  sale_id UUID NULL REFERENCES sales(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN ('debit', 'payment')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  payment_method TEXT NULL,
  notes TEXT NULL,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_tx_customer
  ON customer_credit_transactions (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_tx_company
  ON customer_credit_transactions (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_tx_sale
  ON customer_credit_transactions (sale_id)
  WHERE sale_id IS NOT NULL;

-- View de saldo agregado por (cliente, empresa).
-- balance > 0 = cliente deve; balance <= 0 = quitado/credito.
CREATE OR REPLACE VIEW customer_credit_balances AS
SELECT
  customer_id,
  company_id,
  COALESCE(SUM(CASE type WHEN 'debit' THEN amount ELSE -amount END), 0)::NUMERIC(12,2) AS balance,
  COALESCE(SUM(CASE type WHEN 'debit'   THEN amount ELSE 0 END), 0)::NUMERIC(12,2) AS total_debited,
  COALESCE(SUM(CASE type WHEN 'payment' THEN amount ELSE 0 END), 0)::NUMERIC(12,2) AS total_paid,
  MAX(created_at) AS last_activity_at
FROM customer_credit_transactions
GROUP BY customer_id, company_id;

COMMENT ON TABLE customer_credit_transactions IS
  'Crediario (fiado): debitos por venda + pagamentos avulsos. Saldo via customer_credit_balances. NAO integra com Financeiro/transactions.';

COMMENT ON VIEW customer_credit_balances IS
  'Saldo devedor por (customer_id, company_id). balance>0 = cliente em aberto.';
