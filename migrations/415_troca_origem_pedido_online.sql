-- ============================================================
-- 415 — Troca com origem em pedido da loja online (27/10/2026)
--
-- A troca do Caixa so aceitava venda do Caixa como origem: o item devolvido
-- (troca_returned_items) apontava obrigatoriamente para sales/sale_items.
-- Pedido da loja online vive em digital_orders/digital_order_items e nunca
-- vira linha em sales — a lojista nao achava a venda para trocar.
--
-- O item devolvido passa a poder apontar para o pedido online:
--   original_digital_order_id       -> digital_orders.id
--   original_digital_order_item_id  -> digital_order_items.id (como texto)
-- original_sale_id deixa de ser NOT NULL; o CHECK exige que a linha aponte
-- para uma das duas origens (venda do Caixa OU pedido online).
--
-- A guarda contra devolver duas vezes o mesmo item usa
-- original_digital_order_item_id, como ja acontece com original_sale_item_id.
--
-- Nenhuma linha existente muda: todas tem original_sale_id preenchido e as
-- colunas novas nascem NULL. Idempotente (IF NOT EXISTS / checagem no
-- catalogo antes do CHECK).
--
-- Caminho de volta (so depois de reverter o PR do backend e se nenhuma troca
-- de pedido online tiver sido gravada — senao o SET NOT NULL falha, e e o
-- que se quer):
--   ALTER TABLE troca_returned_items DROP CONSTRAINT IF EXISTS troca_returned_items_origem_chk;
--   ALTER TABLE troca_returned_items DROP COLUMN IF EXISTS original_digital_order_item_id;
--   ALTER TABLE troca_returned_items DROP COLUMN IF EXISTS original_digital_order_id;
--   ALTER TABLE troca_returned_items ALTER COLUMN original_sale_id SET NOT NULL;
-- ============================================================

ALTER TABLE troca_returned_items
  ADD COLUMN IF NOT EXISTS original_digital_order_id UUID
    REFERENCES digital_orders(id) ON DELETE RESTRICT;

-- TEXT e sem FK de proposito: digital_order_items.id e BIGINT em producao
-- (src/migrations/043) e UUID no banco montado so por migrations/ (070, o do
-- CI). O id vai como texto nos dois; a validacao de que o item pertence ao
-- pedido e feita no trocaV2 (validateDigitalReturnedItems).
ALTER TABLE troca_returned_items
  ADD COLUMN IF NOT EXISTS original_digital_order_item_id TEXT;

ALTER TABLE troca_returned_items ALTER COLUMN original_sale_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'troca_returned_items_origem_chk'
       AND conrelid = 'troca_returned_items'::regclass
  ) THEN
    ALTER TABLE troca_returned_items
      ADD CONSTRAINT troca_returned_items_origem_chk
      CHECK (original_sale_id IS NOT NULL OR original_digital_order_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_troca_returned_items_digital_item
  ON troca_returned_items (original_digital_order_item_id)
  WHERE original_digital_order_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_troca_returned_items_digital_order
  ON troca_returned_items (original_digital_order_id)
  WHERE original_digital_order_id IS NOT NULL;

COMMENT ON COLUMN troca_returned_items.original_digital_order_id IS
  'Pedido da loja online de onde veio o item devolvido (27/10/2026). NULL = origem e venda do Caixa (original_sale_id).';
COMMENT ON COLUMN troca_returned_items.original_digital_order_item_id IS
  'Linha de digital_order_items devolvida — guarda contra devolver duas vezes o mesmo item do pedido online.';
