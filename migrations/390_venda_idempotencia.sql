-- ============================================================
-- 390 — Venda idempotente no Caixa (card tq-15, 17/10/2026)
--
-- O POST /pdv/sale nao tinha chave de idempotencia: um timeout de rede com a
-- venda ja gravada, seguido de nova tentativa, ou duas abas finalizando o
-- mesmo carrinho restaurado, gravavam DUAS vendas (estoque baixado duas
-- vezes, duas receitas, crediario em dobro).
--
-- O app passa a mandar o cabecalho `Idempotency-Key` (um uuid por carrinho,
-- renovado so depois de uma venda concluida). O servidor (services/
-- vendaIdempotente.js) grava a chave na venda; a mesma chave da mesma empresa
-- devolve a venda ja registrada, sem gravar de novo.
--
--   idempotency_key       chave mandada pelo app (NULL = venda sem chave,
--                         como todas as anteriores e as de clientes antigos)
--   idempotency_response  corpo da resposta 201 da primeira vez, devolvido
--                         igual na repeticao. Gravado depois do COMMIT, sem
--                         esperar; se faltar, a repeticao remonta o basico.
--
-- A garantia e o indice UNICO parcial: duas requisicoes simultaneas com a
-- mesma chave nao gravam duas linhas, mesmo que a trava da rota falhe.
-- Indice parcial: as vendas sem chave (todas as de hoje) nao entram nele.
--
-- Idempotente (IF NOT EXISTS). O backend pode subir antes desta migration:
-- sem as colunas a rota segue sem idempotencia (comportamento de antes).
-- Caminho de volta: DROP INDEX uq_sales_company_idempotency_key;
--   ALTER TABLE sales DROP COLUMN idempotency_response, DROP COLUMN idempotency_key;
-- ============================================================

ALTER TABLE sales ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS idempotency_response JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_company_idempotency_key
  ON sales (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN sales.idempotency_key IS
  'Idempotency-Key do POST /pdv/sale (uuid por carrinho, gerado no app). NULL = venda sem chave.';
COMMENT ON COLUMN sales.idempotency_response IS
  'Corpo da resposta 201 da primeira vez, devolvido na repeticao da mesma chave (services/vendaIdempotente.js).';
