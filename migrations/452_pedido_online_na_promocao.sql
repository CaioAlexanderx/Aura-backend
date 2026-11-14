-- ============================================================
-- 452 — Item do pedido online sabe se saiu na promoção (p-123a, 14/11/2026)
--
-- "Vendas na promoção" (Promoção em lote, p-92) só olhava o Caixa: o item
-- vendido guarda preco_lista/em_promocao em sale_items desde a 428. O
-- pedido da loja online cobra o mesmo preço efetivo (De/Por), mas o item
-- dele (digital_order_items) não guardava se a promoção valia. QA na loja
-- real (14/11): pedido confirmado a preço promocional e o placar dizia
-- "Ainda sem vendas na promoção".
--
--   preco_lista  o "De" (preço normal) na hora do pedido
--   em_promocao  a promoção valia na hora do pedido
--
-- Mesma regra da 428 (services/vendaNaPromocao.js marcacaoDoItem). NULL =
-- "não sabemos" (pedido anterior a esta migration ou de outra origem, como
-- o Studio). O backend tolera a migration ausente: o pedido grava como
-- antes e o resumo conta só o Caixa. Idempotente.
-- ============================================================

ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS preco_lista NUMERIC(12,2);
ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS em_promocao BOOLEAN;
