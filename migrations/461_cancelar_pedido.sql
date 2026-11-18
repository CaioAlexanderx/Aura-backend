-- ============================================================
-- 461 — Cancelar o pedido do balcao (B6 / p-62e, 17/11/2026)
--
-- 1. caixa_movimentos.tipo ganha dois tipos, so para o pedido do balcao:
--      devolucao_sinal  SAIDA de dinheiro da gaveta: o sinal devolvido em
--                       dinheiro no cancelamento (B6, este card).
--      sinal_pedido     ENTRADA de dinheiro na gaveta: o sinal recebido em
--                       dinheiro (card B4b, que liga o caixa ao sinal).
--    Os dois entram aqui juntos para o CHECK mudar uma vez so. Ate o B4b, o
--    fechamento (services/caixaService.js) le so sangria e suprimento e
--    ignora os tipos novos: o dinheiro esperado de hoje NAO muda. Ninguem
--    grava os tipos novos antes do app de 02/12 (trava PEDIDO_LIBERADO).
--
-- 2. digital_orders.refund_kind: o que foi feito do sinal no cancelamento do
--    pedido do balcao. credito (crédito na ficha da cliente), dinheiro, pix
--    ou estorno (devolucao). NULL = pedido sem sinal, ou nao e do balcao.
--
-- digital_orders nasce em src/migrations/043 (legado) em producao e na 070
-- no CI: guardado por to_regclass, como a 313 e a 459.
--
-- Idempotente. Nenhuma linha existente muda (o CHECK novo aceita tudo o que
-- o antigo aceitava). Sem dado de cliente final.
-- Caminho de volta (depois de reverter o PR do backend, e so se nenhuma
-- linha usar os tipos novos):
--   ALTER TABLE caixa_movimentos DROP CONSTRAINT caixa_movimentos_tipo_check;
--   ALTER TABLE caixa_movimentos ADD CONSTRAINT caixa_movimentos_tipo_check
--     CHECK (tipo IN ('sangria','suprimento'));
--   ALTER TABLE digital_orders DROP COLUMN IF EXISTS refund_kind;
-- ============================================================

DO $$
DECLARE
  c record;
BEGIN
  IF to_regclass('public.caixa_movimentos') IS NOT NULL THEN
    FOR c IN
      SELECT conname
        FROM pg_constraint
       WHERE conrelid = 'public.caixa_movimentos'::regclass
         AND contype = 'c'
         AND pg_get_constraintdef(oid) ILIKE '%tipo%'
    LOOP
      EXECUTE format('ALTER TABLE public.caixa_movimentos DROP CONSTRAINT %I', c.conname);
    END LOOP;

    ALTER TABLE public.caixa_movimentos
      ADD CONSTRAINT caixa_movimentos_tipo_check
      CHECK (tipo IN ('sangria', 'suprimento', 'sinal_pedido', 'devolucao_sinal'));

    COMMENT ON COLUMN public.caixa_movimentos.tipo IS
      'sangria (sai) | suprimento (entra) | sinal_pedido (entra, sinal do pedido do balcao em dinheiro, B4b) | devolucao_sinal (sai, sinal devolvido em dinheiro no cancelamento, B6).';
  END IF;

  IF to_regclass('public.digital_orders') IS NOT NULL THEN
    ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS refund_kind TEXT;
    BEGIN
      ALTER TABLE digital_orders
        ADD CONSTRAINT digital_orders_refund_kind_check
        CHECK (refund_kind IS NULL OR refund_kind IN ('credito', 'dinheiro', 'pix', 'estorno'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
    COMMENT ON COLUMN digital_orders.refund_kind IS
      'Pedido do balcao cancelado: o que foi feito do sinal. credito (ficha da cliente) | dinheiro | pix | estorno. NULL = sem sinal.';
  END IF;
END $$;
