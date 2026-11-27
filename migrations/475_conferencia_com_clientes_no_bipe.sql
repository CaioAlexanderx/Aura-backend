-- 475: marca do esperado da conferencia (condicional, pos-C14).
-- stock_count_items.com_clientes_no_bipe = pecas com clientes descontadas do
-- estoque_no_bipe quando o item foi bipado (0 = nenhuma). NULL = o snapshot
-- foi gravado SEM descontar o que estava com clientes (rascunho aberto antes
-- de a trava CONDICIONAL_LIBERADA ligar): a conferencia nao deixa aplicar esse
-- item ate ele ser contado de novo. Coluna nula e sem default: so metadado,
-- nenhuma linha e reescrita, e sem condicional nada le nem grava nela.
ALTER TABLE stock_count_items
  ADD COLUMN IF NOT EXISTS com_clientes_no_bipe NUMERIC(14,3);
COMMENT ON COLUMN stock_count_items.com_clientes_no_bipe IS
  '475: pecas com clientes descontadas do estoque_no_bipe ao bipar. NULL = snapshot sem desconto (antes da condicional).';
