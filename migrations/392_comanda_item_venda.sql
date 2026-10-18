-- ============================================================
-- 392 — Comanda: fechamento parcial (card tc-04, 17/10/2026)
--
-- Contexto: na 368 a comanda fecha INTEIRA com uma venda (1:1). Na adega,
-- quem vai embora antes paga o que consumiu e a comanda fica aberta para o
-- resto. Agora a venda leva `comanda_id` + `comanda_item_ids` (os itens
-- cobrados) e só esses itens ficam ligados a ela.
--
-- pdv_comanda_items.sale_id: a venda que cobrou este item. NULL = pendente
-- (ainda a cobrar). A comanda fecha quando não sobra item pendente. Venda
-- cancelada devolve os itens (sale_id volta a NULL) e reabre a comanda se
-- ela estava fechada (regra da 368 para o número já reaberto: fica
-- 'cancelled').
--
-- Itens das comandas já fechadas antes desta migration ficam com sale_id
-- NULL: a ligação delas continua em pdv_comandas.sale_id, e cancelar aquela
-- venda segue reabrindo a comanda como antes.
--
-- Idempotente. O backend pode subir antes: sem a coluna, a venda sem
-- comanda_item_ids fecha a comanda inteira como hoje e a cobrança parcial
-- responde 409 COMANDA_PARCIAL_UNAVAILABLE.
-- ============================================================

ALTER TABLE pdv_comanda_items
  ADD COLUMN IF NOT EXISTS sale_id UUID NULL REFERENCES sales(id) ON DELETE SET NULL;

COMMENT ON COLUMN pdv_comanda_items.sale_id IS
  'Venda que cobrou este item (392). NULL = pendente na comanda.';

CREATE INDEX IF NOT EXISTS idx_pdv_comanda_items_sale
  ON pdv_comanda_items (sale_id)
  WHERE sale_id IS NOT NULL;
