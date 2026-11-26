-- ============================================================
-- 471 — Tirar da Fila de producao (Personalizados, C1 do QA de 26/11/2026)
--
-- O Caio quer tirar um item da Fila de producao SEM apagar a venda nem o
-- dinheiro. A Fila (GET /studio/orders) le a view studio_orders, que une tres
-- origens (pedido digital, venda do Caixa e pedido de marketplace) e que o
-- versionamento nao deixa mexer (ver 454). Em vez de tres colunas em tres
-- tabelas grandes e uma view nova, uma tabela pequena guarda "este pedido saiu
-- da Fila", chaveada pelo id da propria view (o id da origem):
--
--   company_id   loja do pedido (multi-CNPJ: toda leitura e escrita confere)
--   order_id     studio_orders.id = digital_orders.id | sales.id | marketplace_orders.id
--   tirado_em    quando saiu da Fila
--   tirado_por   quem tirou (users.id; pode ser NULL)
--   motivo       texto livre opcional (ate 200)
--
-- Tirar = INSERT; devolver a Fila = DELETE. Venda, pedido, Financeiro e
-- estoque nao sao tocados. Tabela nova e vazia: sem lock em tabela grande e
-- sem CONCURRENTLY (o runner usa uma transacao).
--
-- Aditiva e idempotente. Caminho de volta (depois de reverter o PR do backend):
--   DROP TABLE IF EXISTS studio_fila_tirados;
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS studio_fila_tirados (
  order_id    UUID        NOT NULL PRIMARY KEY,
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tirado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tirado_por  UUID,
  motivo      VARCHAR(200)
);

CREATE INDEX IF NOT EXISTS idx_studio_fila_tirados_company
  ON studio_fila_tirados (company_id, tirado_em DESC);

COMMENT ON TABLE studio_fila_tirados IS
  'Pedidos tirados da Fila de producao do Studio/Personalizados (C1). order_id = studio_orders.id. So esconde da Fila; nao altera venda nem dinheiro.';
