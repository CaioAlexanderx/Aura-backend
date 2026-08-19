-- ============================================================
-- 289 — Triagem da arte enviada pelo cliente (S5)
--
-- O fluxo de aprovacao que existe hoje vai no sentido LOJISTA -> CLIENTE:
-- a lojista manda o render e o cliente aprova. O sentido inverso — a
-- lojista avaliar a arte que o cliente enviou — nao existia.
--
-- E ele NAO e um portao de qualidade (DEC-11): ajustar a arte do cliente
-- para caber no produto e para as cores de impressao e rotina, acontece
-- na maioria dos pedidos. A pergunta da lojista nao e "aprovo ou
-- rejeito", e "ajusto por conta ou cobro por isso".
--
-- Por isso a triagem NAO bloqueia o pedido e nao tem estado proprio de
-- pedido: e metadado do ITEM. O pedido segue seu curso enquanto a arte
-- e tratada, exatamente como acontece hoje na pratica.
--
-- status:
--   pendente   — arte recebida, ainda nao olhada (default de item com arte)
--   aceita     — entra em producao como veio
--   ajustando  — a lojista esta refazendo para caber/imprimir
--   devolvida  — o cliente precisa mandar outro arquivo
--
-- NULL = item que nao tem arte de cliente para revisar (o cliente
-- contratou a criacao, ou o produto nao e personalizavel). Coluna
-- anulavel de proposito: nao existe backfill correto para pedido antigo.
-- ============================================================

ALTER TABLE digital_order_items
  ADD COLUMN IF NOT EXISTS art_review_status TEXT,
  ADD COLUMN IF NOT EXISTS art_review_note   TEXT,
  ADD COLUMN IF NOT EXISTS art_reviewed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS art_reviewed_by   UUID;

DO $$
BEGIN
  ALTER TABLE digital_order_items
    ADD CONSTRAINT digital_order_items_art_review_status_chk
    CHECK (art_review_status IS NULL OR art_review_status IN
           ('pendente', 'aceita', 'ajustando', 'devolvida'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN digital_order_items.art_review_status IS
  'Triagem da arte enviada pelo cliente (S5). NULL = nao ha arte de cliente para revisar.';
COMMENT ON COLUMN digital_order_items.art_review_note IS
  'Observacao da lojista na triagem — o que foi ajustado, ou por que voltou.';

-- A fila e sempre "o que esta pendente, mais recente primeiro". Indice
-- parcial: so as linhas em triagem entram, e nao ha custo nas outras.
CREATE INDEX IF NOT EXISTS idx_doi_art_review_pendente
  ON digital_order_items (order_id)
  WHERE art_review_status = 'pendente';
