-- ============================================================
-- 313 — AURINHA: atribuição de venda (contrato de checkout)
--
-- A Aurinha fecha venda mandando o link da loja virtual com o produto
-- pré-aberto (contrato em docs/aurinha-checkout-contract.md):
--   loja.getaura.com.br/:slug?produto=<id>&variante=<sku>&origem=aurinha&conversa=<uuid>
-- A loja repaginada propaga origem/conversa no POST /storefront/:slug/order
-- e o pedido fica atribuível — é a métrica de conversão do hub social
-- (quantas vendas a Aurinha fechou).
--
-- digital_orders nasce em src/migrations/043 (LEGADO, fora do CI):
-- o ALTER inteiro vai num DO $$ guardado por information_schema — no CI
-- (onde a tabela não existe) o bloco vira no-op; em prod aplica. Sem FK
-- (regra da casa: nada de DDL referenciando tabelas do diretório legado
-- — e FK a partir delas também não, o vínculo é lógico via UUID).
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'digital_orders') THEN
    ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS origem TEXT;
    ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS hub_conversation_id UUID;
    COMMENT ON COLUMN digital_orders.origem IS
      'Canal que originou o pedido (ex.: aurinha). Livre, max validado no runtime.';
    COMMENT ON COLUMN digital_orders.hub_conversation_id IS
      'Conversa do hub social que gerou o pedido (vínculo lógico com hub_conversations, sem FK — ver cabeçalho).';
    CREATE INDEX IF NOT EXISTS idx_digital_orders_hub_conv
      ON digital_orders(hub_conversation_id) WHERE hub_conversation_id IS NOT NULL;
  END IF;
END $$;

-- ============================================================
-- FIM DA MIGRATION 313
-- ============================================================
