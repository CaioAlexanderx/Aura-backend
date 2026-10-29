-- ============================================================
-- 417 — Pagar na entrega com forma, troco e aceite da lojista (tq-44, 29/10/2026)
--
-- Desenho aprovado pela Nina (Produto) em 19/10, piloto numa adega.
--
--   digital_channel_config.pay_on_delivery_methods  formas que a loja recebe
--       na porta: 'cash' (dinheiro, com troco), 'card' (cartao na maquina),
--       'pix' (Pix na hora). NULL ou vazio = o pagar na entrega de hoje, sem
--       aceite: as lojas que ja tinham a opcao ligada nao mudam ate a
--       lojista marcar as formas no painel.
--
--   digital_orders.pay_on_delivery_method  a forma que a cliente escolheu.
--   digital_orders.change_for              "troco para quanto" (so dinheiro).
--   digital_orders.accepted_at             quando a lojista aceitou.
--   digital_orders.prep_minutes            tempo de preparo informado no aceite.
--
-- Status novo 'aguardando_aceite': o pedido de pagar na entrega com forma
-- nasce assim, sem baixa de estoque e sem lancamento. O aceite baixa e
-- lanca a receber (services/aceiteDoPedido.js). Em producao a coluna
-- status e TEXT e nao precisa de nada; no banco montado so pelas
-- migrations (CI) ela ainda e o ENUM da 070, e o valor entra no enum
-- (mesma receita da 090).
--
-- Nenhuma linha existente muda. Idempotente (IF NOT EXISTS).
-- Caminho de volta (depois de reverter o PR do backend):
--   ALTER TABLE digital_channel_config DROP COLUMN IF EXISTS pay_on_delivery_methods;
--   ALTER TABLE digital_orders DROP COLUMN IF EXISTS pay_on_delivery_method,
--     DROP COLUMN IF EXISTS change_for, DROP COLUMN IF EXISTS accepted_at,
--     DROP COLUMN IF EXISTS prep_minutes;
--   (pedidos que ficaram em 'aguardando_aceite' devem ser aceitos ou
--   recusados antes do revert; o valor do enum do CI pode ficar.)
-- ============================================================

ALTER TABLE digital_channel_config ADD COLUMN IF NOT EXISTS pay_on_delivery_methods TEXT[];

ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS pay_on_delivery_method TEXT;
ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS change_for NUMERIC(12,2);
ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS prep_minutes INTEGER;

DO $$ BEGIN
  ALTER TABLE digital_orders ADD CONSTRAINT digital_orders_pay_on_delivery_method_check
    CHECK (pay_on_delivery_method IS NULL OR pay_on_delivery_method IN ('cash', 'card', 'pix'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'digital_order_status') THEN
    EXECUTE 'ALTER TYPE digital_order_status ADD VALUE IF NOT EXISTS ''aguardando_aceite''';
  END IF;
END $$;

COMMENT ON COLUMN digital_channel_config.pay_on_delivery_methods IS
  'tq-44: formas de pagar na entrega (cash, card, pix). NULL/vazio = pagar na entrega sem aceite (comportamento anterior).';
COMMENT ON COLUMN digital_orders.pay_on_delivery_method IS
  'tq-44: forma escolhida pela cliente no pagar na entrega (cash, card, pix). NULL nos outros pedidos.';
COMMENT ON COLUMN digital_orders.change_for IS
  'tq-44: troco para quanto (so dinheiro). NULL = sem troco.';
