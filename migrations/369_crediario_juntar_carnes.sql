-- ============================================================
-- 369 — Crediario: um carne por compra e "juntar carnes"
--       · 10/10/2026
--
-- 1. Juntar carnes: a lojista marca 2+ carnes em aberto e parcela tudo de
--    uma vez. Os carnes de origem fecham e passam a apontar para o carne
--    novo. Sem o apontamento a origem ficaria como "fechada" solta na ficha
--    -- parecendo um carne quitado, quando na verdade a divida mudou de
--    lugar. merged_into_account_id diz para onde ela foi; merged_at, quando.
--
--    O codigo funciona sem esta migration (services/credit/mergeCarnes.js
--    marca a origem como status 'merged' e ela sai da ficha do mesmo jeito),
--    mas ai nao ha como dizer em qual carne ela foi parar.
--
-- 2. Indices por carne. Ate hoje nenhuma venda do Caixa caia em carne (482
--    debitos de venda, zero com account_id). Com um carne por compra, as
--    consultas "o que tem neste carne" passam a rodar em toda ficha, toda
--    impressao e todo cancelamento de venda.
--
-- Nao altera dado nenhum: so colunas e indices novos. Idempotente.
-- ============================================================

ALTER TABLE credit_accounts
  ADD COLUMN IF NOT EXISTS merged_into_account_id uuid;

ALTER TABLE credit_accounts
  ADD COLUMN IF NOT EXISTS merged_at timestamptz;

COMMENT ON COLUMN credit_accounts.merged_into_account_id IS
  'Carne destino quando este foi juntado a outros (POST /credit/customers/:cid/accounts/merge). Nulo = nunca foi juntado.';

CREATE INDEX IF NOT EXISTS idx_credit_accounts_merged_into
  ON credit_accounts (merged_into_account_id)
  WHERE merged_into_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_transactions_account
  ON customer_credit_transactions (account_id)
  WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_credit_installments_account
  ON credit_installments (account_id)
  WHERE account_id IS NOT NULL;
