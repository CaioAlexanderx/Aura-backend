-- ============================================================
-- 439 — Venda cancelada sai da lista (10/11/2026)
--
-- Pedido do Caio: "Linha de venda cancelada pode ser excluída, para não
-- poluir a UI."
--
-- A exclusão é LÓGICA. Venda cancelada é registro financeiro e fiscal
-- (NFC-e cancelada, estorno, comissão, caixa): nada é apagado. A linha só
-- some das listas de Vendas (por empresa e consolidada); o registro fica
-- no banco com quem tirou e quando.
--
--   hidden_at  quando a venda saiu da lista (NULL = aparece normalmente)
--   hidden_by  users.id de quem tirou (mesmo padrão de cancelled_by)
--
-- Só a venda JÁ CANCELADA pode ser ocultada (POST
-- /companies/:id/sales/:sale_id/hide recusa as outras com 409). Os totais
-- da tela não mudam: os stats continuam contando todas as vendas do
-- período, ocultas ou não; só a lista paginada filtra hidden_at IS NULL.
--
-- Só ADITIVA e idempotente: duas colunas nuláveis, sem default, sem
-- backfill, sem índice, sem reescrita de tabela. O backend sonda a coluna
-- (src/utils/saleHidden.js) e segue como antes enquanto ela não existe.
--
-- Caminho de volta (depois de reverter o PR):
--   ALTER TABLE sales DROP COLUMN IF EXISTS hidden_by;
--   ALTER TABLE sales DROP COLUMN IF EXISTS hidden_at;
-- ============================================================

ALTER TABLE sales ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS hidden_by uuid;

COMMENT ON COLUMN sales.hidden_at IS
  'Quando a venda cancelada saiu da lista de Vendas (exclusão lógica; o registro fica). NULL = aparece. Migration 439.';
COMMENT ON COLUMN sales.hidden_by IS
  'users.id de quem tirou a venda cancelada da lista. Migration 439.';
