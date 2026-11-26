-- ============================================================
-- 468 — Venda condicional: pecas "para resolver" (C9, 26/11/2026)
--
-- A peca que volta com defeito ou sem etiqueta (situacao 'voltou_defeito')
-- sai da condicional, NAO volta a livre e NAO conta em "com clientes": fica
-- "para resolver" ate alguem decidir "Voltar ao estoque" ou "Dar baixa"
-- (C16). Livres = estoque − com clientes − reservado − para resolver.
--
--   resolved_at  quando a peca foi resolvida (C16). NULL = ainda para
--                resolver. So faz sentido com situacao 'voltou_defeito'.
--   resolved_by  quem resolveu.
--
-- O C9 so le (resolved_at IS NULL conta; peca resolvida nao muda mais de
-- situacao). As acoes e os eventos de resolver sao do C16.
--
-- Indice parcial idx_condicional_itens_resolver: cobre exatamente o filtro
-- de services/comClientes.js (SQL_PARA_RESOLVER). condicional_itens nasceu
-- na 467 (tabela nova e pequena): indice comum, dentro da transacao do
-- runner (nada de CONCURRENTLY).
--
-- Aditiva e idempotente. Nenhuma linha existente muda.
-- Caminho de volta (depois de reverter o PR do backend):
--   DROP INDEX IF EXISTS idx_condicional_itens_resolver;
--   ALTER TABLE condicional_itens DROP COLUMN IF EXISTS resolved_by,
--     DROP COLUMN IF EXISTS resolved_at;
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE condicional_itens ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE condicional_itens ADD COLUMN IF NOT EXISTS resolved_by UUID;

COMMENT ON COLUMN condicional_itens.resolved_at IS
  'Peca voltou_defeito resolvida (C16: voltar ao estoque ou dar baixa). NULL com voltou_defeito = para resolver (fora do livre).';

CREATE INDEX IF NOT EXISTS idx_condicional_itens_resolver
  ON condicional_itens (product_id, variant_id)
  WHERE situacao = 'voltou_defeito' AND resolved_at IS NULL;

RESET lock_timeout;
