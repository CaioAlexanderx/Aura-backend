-- 316 — desconto no pedido da loja online (02/09/2026, fase 6 do redesign)
--
-- A loja anuncia "R$ X no Pix" desde a migration 309 (pix_discount_pct), mas
-- o pedido cobrava o preço cheio: POST /storefront/:slug/order somava
-- subtotal + frete e ignorava o desconto. Anunciar desconto que o pedido não
-- dá é pior que não anunciar.
--
-- O desconto passa a ser calculado no SERVIDOR ao criar o pedido (nunca
-- confiado no cliente) e gravado aqui, para o Caixa e o app verem por que o
-- total é menor que a soma dos itens. `total` continua sendo o que a cliente
-- paga: subtotal - discount_amount + delivery_fee.
--
-- Idempotente. O runner (preDeployCommand) aplica antes do código subir.

ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS discount_reason TEXT;

COMMENT ON COLUMN digital_orders.discount_amount IS
  'Desconto aplicado ao pedido, em reais. Hoje só o do Pix (pix_discount_pct da loja). total = subtotal - discount_amount + delivery_fee.';
COMMENT ON COLUMN digital_orders.discount_reason IS
  'Origem do desconto: ''pix'' quando veio do desconto do Pix da loja.';
