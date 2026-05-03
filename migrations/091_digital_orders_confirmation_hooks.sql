-- ============================================================
-- 091_digital_orders_confirmation_hooks.sql
-- AURA. — Canal Digital: rastreamento de cliente + transacao + estoque
--
-- Adiciona colunas pra rastrear:
--   * stock_deducted: idempotencia da baixa de estoque
--   * customer_id: cliente vinculado (cadastrado/match no checkout)
--   * transaction_id: lancamento financeiro gerado
--
-- Remove trigger SQL antigo (migration 070, nao aplicado em prod) que
-- nao suportava variantes. A logica passa pra src/services/digitalOrderConfirmation.js
-- que trata estoque + cliente + financeiro atomicamente em transacao Node.
-- ============================================================

-- 1. Colunas de rastreamento (idempotente)
ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS stock_deducted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS customer_id    UUID REFERENCES customers(id)    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL;

COMMENT ON COLUMN digital_orders.stock_deducted IS
  'Idempotencia: TRUE apos baixa de estoque. Evita dupla deducao em retries.';
COMMENT ON COLUMN digital_orders.customer_id IS
  'Cliente vinculado ao pedido (match por phone normalizado no checkout).';
COMMENT ON COLUMN digital_orders.transaction_id IS
  'Transaction (income) gerada quando pedido confirma. NULL ate confirmar.';

-- 2. Index pra listagem de pedidos por cliente
CREATE INDEX IF NOT EXISTS idx_digital_orders_customer
  ON digital_orders(customer_id, created_at DESC)
  WHERE customer_id IS NOT NULL;

-- 3. Remover trigger SQL antigo (migration 070 — nao suportava variantes)
--    A nova logica vive em src/services/digitalOrderConfirmation.js
DROP TRIGGER IF EXISTS trg_digital_order_stock_deduct ON digital_orders;
DROP FUNCTION IF EXISTS deduct_stock_on_order_confirmed();

-- 4. UNIQUE em transactions(idempotency_key) — pra impedir dupla criacao
--    de lancamento financeiro pro mesmo pedido digital
CREATE UNIQUE INDEX IF NOT EXISTS uq_transactions_idempotency_key
  ON transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
