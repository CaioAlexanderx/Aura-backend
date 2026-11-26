-- ============================================================
-- 470 — Venda condicional: resolver as pecas "para resolver" (C16, 26/11/2026)
--
-- A peca 'voltou_defeito' (468) sai de "para resolver" por uma de duas
-- acoes da lojista:
--   voltar_estoque  grava resolved_at/resolved_by; a peca volta a contar
--                   como livre (o estoque fisico nao muda). Pode ser
--                   desfeita por poucos segundos.
--   baixa           grava resolved_at/resolved_by E da baixa de 1 unidade
--                   (stock_movements 'adjustment', motivo na nota).
--
--   resolved_acao   qual das duas (NULL = nao resolvida). O desfazer so vale
--                   para voltar_estoque.
--
-- Eventos novos em condicional_eventos.tipo: 'resolvida_voltou',
-- 'resolvida_baixa', 'resolucao_desfeita'. O CHECK e recriado INTEIRO: junta
-- os da 467, os da 469 ('venda_cancelada', 'reaberta', C11) e os novos.
-- condicional_eventos nasceu na 467 (tabela nova e pequena); lock_timeout
-- curto e sem CONCURRENTLY (o runner usa uma transacao).
--
-- Aditiva e idempotente. Nenhuma linha existente muda.
-- Caminho de volta (depois de reverter o PR do backend; antes, apague ou
-- converta eventos com os tipos novos):
--   ALTER TABLE condicional_itens DROP COLUMN IF EXISTS resolved_acao;
--   ALTER TABLE condicional_eventos DROP CONSTRAINT IF EXISTS condicional_eventos_tipo_check;
--   (recriar o CHECK com a lista da 469)
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE condicional_itens ADD COLUMN IF NOT EXISTS resolved_acao TEXT;

COMMENT ON COLUMN condicional_itens.resolved_acao IS
  'Como a peca voltou_defeito foi resolvida (C16): voltar_estoque | baixa. NULL = nao resolvida.';

ALTER TABLE condicional_eventos DROP CONSTRAINT IF EXISTS condicional_eventos_tipo_check;
ALTER TABLE condicional_eventos
  ADD CONSTRAINT condicional_eventos_tipo_check
  CHECK (tipo IN ('criada', 'peca_acrescentada', 'ficou', 'voltou', 'voltou_defeito',
                  'ainda_com_ela', 'nova_data', 'venda', 'cancelada', 'encerrada',
                  'venda_cancelada', 'reaberta',
                  'resolvida_voltou', 'resolvida_baixa', 'resolucao_desfeita'));

RESET lock_timeout;
