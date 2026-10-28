-- ============================================================
-- 416 — Pedido da loja online idempotente (27/10/2026)
--
-- Medido em producao: cada compra pela loja online gerava de 3 a 5 pedidos
-- iguais em digital_orders (mesma cliente, mesmo item, 0,1 a 0,7 s de
-- diferenca). Os botoes de forma de pagamento do checkout chamavam o envio
-- sem trava e o POST /storefront/:slug/order nao tinha chave de
-- idempotencia: cada toque virava um pedido novo.
--
-- A vitrine passa a mandar uma chave por tentativa de checkout. O servidor
-- (services/pedidoOnlineIdempotente.js) grava a chave no pedido; a mesma
-- chave da mesma loja devolve o pedido ja criado, sem criar outro.
--
--   idempotency_key       chave mandada pela vitrine (NULL = pedido sem
--                         chave, como todos os anteriores e os de pagina
--                         antiga em cache)
--   idempotency_response  corpo da resposta 201 da primeira vez (com o Pix e
--                         o link do cartao), devolvido na repeticao.
--
-- A garantia e o indice UNICO parcial: dois toques simultaneos com a mesma
-- chave nao gravam dois pedidos, mesmo que a trava da rota falhe. Parcial:
-- os pedidos sem chave (todos os de hoje) nao entram nele. Nenhuma linha
-- existente muda.
--
-- Idempotente (IF NOT EXISTS). O backend pode subir antes desta migration:
-- sem as colunas a rota segue sem idempotencia (comportamento de antes).
-- Caminho de volta (depois de reverter o PR do backend):
--   DROP INDEX IF EXISTS uq_digital_orders_company_idempotency_key;
--   ALTER TABLE digital_orders DROP COLUMN IF EXISTS idempotency_response,
--                              DROP COLUMN IF EXISTS idempotency_key;
-- ============================================================

ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS idempotency_response JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS uq_digital_orders_company_idempotency_key
  ON digital_orders (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN digital_orders.idempotency_key IS
  'Chave do POST /storefront/:slug/order (uma por tentativa de checkout, gerada na vitrine). NULL = pedido sem chave.';
COMMENT ON COLUMN digital_orders.idempotency_response IS
  'Corpo da resposta 201 da primeira vez, devolvido na repeticao da mesma chave (services/pedidoOnlineIdempotente.js).';
