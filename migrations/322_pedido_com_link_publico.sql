-- ============================================================
-- 322 — Link publico de acompanhamento para o pedido da vitrine
-- 05/09/2026
--
-- POR QUE: a pagina /acompanhar/<token> existe desde o K3 (18/08/2026)
-- para a encomenda do balcao (sales.tracker_token, migration 286). O
-- pedido da VITRINE nao chegava nela: digital_orders nao tinha token, a
-- confirmacao nao dava link, e a cliente so descobria a etapa perguntando
-- no WhatsApp — exatamente a pergunta que a lojista quer parar de
-- responder.
--
-- Mesmo desenho da 286: gerado por DEFAULT no banco, para o link existir
-- no instante em que o pedido nasce e viajar no RETURNING * sem consulta
-- extra. 16 bytes aleatorios em hex; o token E a credencial da pagina,
-- que abre sem login, entao precisa ser impossivel de enumerar. Sem
-- expiracao: vale ate a entrega.
-- ============================================================

ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS public_token TEXT DEFAULT encode(gen_random_bytes(16), 'hex');

-- Pedidos ja gravados tambem ganham link: a lojista pode querer mandar o
-- acompanhamento de um pedido que esta em producao hoje.
UPDATE digital_orders
   SET public_token = encode(gen_random_bytes(16), 'hex')
 WHERE public_token IS NULL;

-- UNIQUE garante que um token nunca resolve dois pedidos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_digital_orders_public_token
  ON digital_orders (public_token)
  WHERE public_token IS NOT NULL;

COMMENT ON COLUMN digital_orders.public_token IS
  'Credencial do acompanhamento publico (/acompanhar/:token) do pedido da vitrine. Gerado por DEFAULT. Sem expiracao.';
