-- ============================================================
-- 334 — Distribuição de cada pagamento do crediário entre as parcelas
--
-- Feedback de lojista (15/09/2026): o recibo de pagamento saía "sobre o
-- valor, e não sobre a parcela". O applyPayment sempre calculou quais
-- parcelas cada pagamento cobriu (encargos primeiro, depois principal,
-- oldest-first), mas só devolvia essa lista para a tela e a descartava.
-- O recibo, impresso depois pelo Histórico, não tinha de onde tirá-la.
--
-- Uma linha por (pagamento, parcela): quanto de principal e de encargos
-- aquele pagamento pôs na parcela, e a situação em que ela ficou logo
-- depois ('paid' = quitada; outro valor = parcial). É um retrato do
-- momento do pagamento — não é recalculado quando a parcela muda depois.
--
-- Pagamentos anteriores a esta migration não têm linhas: o recibo deles
-- continua saindo sem o bloco de parcelas.
--
-- ON DELETE CASCADE nos dois lados: desfazer o pagamento ou cancelar a
-- parcela leva a distribuição junto, sem órfão.
-- ============================================================

CREATE TABLE IF NOT EXISTS credit_payment_allocations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transaction_id  UUID NOT NULL REFERENCES customer_credit_transactions(id) ON DELETE CASCADE,
  installment_id  UUID NOT NULL REFERENCES credit_installments(id) ON DELETE CASCADE,
  principal_paid  NUMERIC(12,2) NOT NULL DEFAULT 0,
  charges_paid    NUMERIC(12,2) NOT NULL DEFAULT 0,
  status_after    VARCHAR(20),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cpa_transaction_installment UNIQUE (transaction_id, installment_id)
);

-- A constraint UNIQUE já indexa por transaction_id (leitura do recibo).
-- Este índice serve o caminho inverso: "quais pagamentos cobriram esta parcela".
CREATE INDEX IF NOT EXISTS idx_cpa_installment
  ON credit_payment_allocations (installment_id);
