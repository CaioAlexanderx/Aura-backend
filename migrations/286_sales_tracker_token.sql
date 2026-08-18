-- ============================================================
-- AURA — K3 (Quadro Vivo): tracker publico da encomenda
-- 18/08/2026
--
-- O cliente de encomenda personalizada espera dias e nao tem como saber
-- em que pe esta. A duvida vira mensagem no WhatsApp da lojista, varias
-- vezes ao dia, e o custo real e o tempo dela.
--
-- A pesquisa de operational transparency (Buell, HBS) mediu +22% de
-- qualidade percebida quando o cliente VE o trabalho sendo feito -- e o
-- padrao "pizza tracker" virou expectativa em qualquer vertical. Aqui ele
-- rende mais que na pizza: a espera e de dias, nao de minutos.
--
-- DESENHO DO TOKEN
--
-- Gerado por DEFAULT no banco, e nao pela aplicacao, porque a premissa do
-- projeto e que a lojista nao gere, nao copie e nao ative nada: o link tem
-- que existir no instante em que a venda fecha, pra viajar junto na
-- mensagem que o checkout ja monta.
--
-- 16 bytes aleatorios (128 bits) em hex. O token E a credencial -- quem
-- tem o link ve o pedido, mesmo padrao do studio_approval_links. Por isso
-- entropia alta: precisa ser impossivel de adivinhar ou enumerar.
--
-- Sem expiracao, ao contrario do link de aprovacao: a aprovacao e um
-- pedido de resposta com prazo; o acompanhamento vale ate a entrega, e um
-- link morto no meio da espera seria pior que nao ter link.
--
-- Aplicado a TODA venda, nao so as do Studio. O token e barato (32 chars)
-- e amarrar a coluna ao vertical criaria link quebrado no dia em que a
-- empresa mudasse de vertical.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS + backfill so onde falta.
-- ============================================================

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS tracker_token TEXT DEFAULT encode(gen_random_bytes(16), 'hex');

-- Vendas ja gravadas tambem ganham link (a lojista pode querer mandar o
-- acompanhamento de uma encomenda em andamento hoje).
UPDATE sales
   SET tracker_token = encode(gen_random_bytes(16), 'hex')
 WHERE tracker_token IS NULL;

-- UNIQUE e o que garante que um token nunca resolve dois pedidos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tracker_token
  ON sales (tracker_token)
  WHERE tracker_token IS NOT NULL;

COMMENT ON COLUMN sales.tracker_token IS
  'K3 (18/08/2026): credencial do acompanhamento publico da encomenda (/acompanhar/:token). Gerado por DEFAULT no banco pra existir no instante da venda. Sem expiracao — vale ate a entrega.';
