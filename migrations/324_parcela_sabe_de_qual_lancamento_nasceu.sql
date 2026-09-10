-- ============================================================
-- 324: a parcela sabe de qual lancamento manual ela nasceu (10/09/2026)
--
-- Incidente Jenniffer (looks da jenny), cliente Ana Lucia: DELETE
-- /credit/transaction/:txid apagava so a linha do ledger. As parcelas que o
-- /manual-entry tinha criado junto ficavam vivas, o FIFO de pagamentos seguia
-- cobrindo-as e a ficha mostrava EM ABERTO R$199 (ledger) com parcelas somando
-- R$938 -- duas verdades na mesma tela.
--
-- Nao existia ligacao entre customer_credit_transactions e credit_installments
-- (parcela de venda tem sale_id; parcela de lancamento manual nao tinha nada).
-- Esta coluna fecha o vao: o /manual-entry grava transaction_id nas parcelas e
-- o "desfazer" cancela exatamente essas.
-- ============================================================

ALTER TABLE credit_installments
  ADD COLUMN IF NOT EXISTS transaction_id UUID
    REFERENCES customer_credit_transactions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_credit_installments_transaction_id
  ON credit_installments (transaction_id)
  WHERE transaction_id IS NOT NULL;

-- Backfill so onde e inequivoco: debito manual e parcelas gravados no mesmo
-- NOW() (mesma transacao, lancamento sem data retroativa). Lancamentos com
-- data retroativa ficam sem vinculo aqui; o "desfazer" ainda os encontra pela
-- soma das parcelas (src/services/credit/undoManualEntry.js).
UPDATE credit_installments ci
   SET transaction_id = t.id
  FROM customer_credit_transactions t
 WHERE ci.transaction_id IS NULL
   AND ci.sale_id IS NULL
   AND t.type = 'debit'
   AND t.sale_id IS NULL
   AND t.source = 'manual'
   AND t.company_id  = ci.company_id
   AND t.customer_id = ci.customer_id
   AND t.created_at  = ci.created_at
   AND t.account_id IS NOT DISTINCT FROM ci.account_id;
