-- ============================================================
-- 115_troca_returned_items_original_sale_item.sql
-- Troca v2 — coluna pra rastrear EXATAMENTE qual sale_item esta
-- sendo devolvido. Destrava validacao de dupla-devolucao:
--
--   "Cliente trouxe 1 de 3 ontem em uma troca, traz mais 2 hoje.
--    So restam 2 a devolver — o sistema atual aceitaria 3."
--
-- Backend v2 valida:
--   SUM(troca_returned_items.quantity) FILTER (
--     WHERE original_sale_item_id = X
--     AND troca_sale.status != 'cancelled'
--   ) + nova_qtd <= sale_items.quantity
--
-- COMPAT: coluna nullable — trocas legadas (anteriores) ficam com
-- NULL e nao participam da validacao. v2 sempre preenche.
--
-- Doc: Aura/AUDITORIA_TROCA_PDV_2026-05-17.docx (Fase 1)
-- ============================================================

ALTER TABLE troca_returned_items
  ADD COLUMN IF NOT EXISTS original_sale_item_id UUID NULL
    REFERENCES sale_items(id) ON DELETE SET NULL;

-- Index pra a query de validacao de dupla-devolucao.
CREATE INDEX IF NOT EXISTS idx_troca_ret_original_sale_item
  ON troca_returned_items (original_sale_item_id)
  WHERE original_sale_item_id IS NOT NULL;

COMMENT ON COLUMN troca_returned_items.original_sale_item_id IS
  'sale_items.id da venda original sendo devolvido. Nullable pra '
  'trocas legadas (pre-v2). Backend v2 valida que SUM(quantity) '
  'agrupado por este id nao excede sale_items.quantity correspondente.';
