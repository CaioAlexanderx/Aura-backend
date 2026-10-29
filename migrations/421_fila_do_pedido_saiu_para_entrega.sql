-- ============================================================
-- 421 — Fila do pedido da loja online: "saiu para entrega" e devolucao
-- marcada (tq-47, 29/10/2026 — desenho da Nina, 19/10). Depende da 420.
--
--   digital_orders.out_for_delivery_at  quando a lojista marcou a saida.
--   digital_orders.refund_marked_at     pedido pago online e recusado: a
--       lojista devolveu o valor por fora e marcou (reembolso no gateway
--       ainda nao existe — decisao do Caio).
--
-- Status novo 'out_for_delivery' (em preparo -> saiu para entrega ->
-- entregue). Em producao status e TEXT; no CI e o ENUM da 070 e o valor
-- entra no enum (receita da 090).
--
-- Nenhuma linha existente muda. Idempotente.
-- Caminho de volta (depois de reverter o PR):
--   ALTER TABLE digital_orders DROP COLUMN IF EXISTS out_for_delivery_at,
--     DROP COLUMN IF EXISTS refund_marked_at;
--   (pedidos em 'out_for_delivery' devem ser marcados entregues antes.)
-- ============================================================

ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS out_for_delivery_at TIMESTAMPTZ;
ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS refund_marked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'digital_order_status') THEN
    EXECUTE 'ALTER TYPE digital_order_status ADD VALUE IF NOT EXISTS ''out_for_delivery''';
  END IF;
END $$;

COMMENT ON COLUMN digital_orders.out_for_delivery_at IS
  'tq-47: quando a lojista marcou que o pedido saiu para entrega.';
COMMENT ON COLUMN digital_orders.refund_marked_at IS
  'tq-47: pedido pago online e recusado; a lojista devolveu o valor por fora e marcou.';
