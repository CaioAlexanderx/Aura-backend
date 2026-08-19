-- ============================================================
-- 292 — Aura Studio · "o cliente abriu o orçamento?"
--
-- studio_quotes já registra sent_at e responded_at, mas nada entre os
-- dois: a lojista manda a proposta e fica no escuro até o cliente
-- responder (ou nunca responder). viewed_at é a primeira abertura do
-- link público — o dado que diz "ele viu e está pensando" em vez de
-- "talvez nem tenha chegado".
--
-- Só a PRIMEIRA visita grava (o UPDATE tem WHERE viewed_at IS NULL na
-- rota), então o campo é "quando viu pela primeira vez", não "última
-- visita" — é o que responde a pergunta da lojista sem virar rastreamento.
--
-- Idempotente. O backend trata a ausência da coluna (42703) e segue sem
-- o dado, então aplicar isto pode ser feito a qualquer momento.
-- ============================================================

ALTER TABLE studio_quotes
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz;

COMMENT ON COLUMN studio_quotes.viewed_at IS
  'Primeira vez que o cliente abriu o link público do orçamento (NULL = ainda não abriu).';
