-- ============================================================
-- 460 — Sinal do pedido do balcao (B4a / p-62a, 17/11/2026)
--
-- O sinal do pedido guardado no Caixa mora em studio_payments (kind
-- 'deposit', status 'paid'), a tabela que o Studio ja usa para o sinal do
-- orcamento (140). Ela nao tem vertical, entao serve ao varejo como esta.
-- Faltam duas coisas, as duas so para o pedido do balcao:
--
--   studio_payments.idempotency_key  Idempotency-Key do POST /pedidos/:oid/sinal.
--                                    A mesma chave da mesma loja devolve o
--                                    sinal ja registrado, sem gravar de novo.
--                                    NULL = sinal sem chave (os do Studio, e o
--                                    sinal que entra junto do POST /pedidos,
--                                    protegido pela chave do proprio pedido).
--   studio_payments.forma            a forma como o Caixa fala (dinheiro, pix,
--                                    cartao = credito, debito). method (140) so
--                                    tem pix/card/cash/other e nao separa
--                                    credito de debito, que tem taxa diferente
--                                    na maquininha. NULL nos sinais do Studio.
--
-- Indice UNICO parcial (company_id, idempotency_key): duas requisicoes com a
-- mesma chave nao gravam dois sinais, mesmo que a trava da rota falhe. As
-- linhas de hoje (sem chave) nao entram nele.
--
-- O dinheiro do sinal NAO depende desta migration: a entrada "Sinal de
-- pedido" e a conta "Pedido a receber" moram em transactions, com as chaves
-- pedido-sinal-<id> e pedido-areceber-<id> (unicas pela constraint de
-- transactions.idempotency_key).
--
-- Idempotente. Nenhuma linha existente muda. Sem dado de cliente final.
-- Caminho de volta (depois de reverter o PR do backend):
--   DROP INDEX IF EXISTS uq_studio_payments_company_idempotency_key;
--   ALTER TABLE studio_payments DROP COLUMN IF EXISTS idempotency_key,
--     DROP COLUMN IF EXISTS forma;
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.studio_payments') IS NOT NULL THEN
    ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE studio_payments ADD COLUMN IF NOT EXISTS forma TEXT;

    BEGIN
      ALTER TABLE studio_payments
        ADD CONSTRAINT studio_payments_forma_check
        CHECK (forma IS NULL OR forma IN ('dinheiro', 'pix', 'cartao', 'debito'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_studio_payments_company_idempotency_key
      ON studio_payments (company_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    COMMENT ON COLUMN studio_payments.idempotency_key IS
      'Idempotency-Key do POST /pedidos/:oid/sinal (pedido do balcao). NULL = sinal sem chave.';
    COMMENT ON COLUMN studio_payments.forma IS
      'Forma do sinal no vocabulario do Caixa: dinheiro, pix, cartao (credito) ou debito. NULL nos sinais do Studio.';
  END IF;
END $$;
