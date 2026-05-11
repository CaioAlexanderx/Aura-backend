-- ============================================================
-- Migration 106 — Cleanup sale_payments órfãos de vendas canceladas
-- Data: 2026-05-11
--
-- Contexto: o endpoint POST /sales/:id/cancel marcava a venda como
-- cancelled, devolvia estoque, e deletava a transaction (pdv-sale-*),
-- mas NÃO deletava os sale_payments associados. Resultado: o card
-- "Fechamentos de Caixa" e o fechamento do caixa atual inflavam o
-- total porque sale_payments dessas vendas continuavam contando.
--
-- Caso real detectado: Davi Calçados Villa Branca, sessão 10/05/2026
-- — 2 vendas canceladas (2 × R$149,99 = R$299,98) deixaram payments
-- residuais que entraram no fechamento do dia.
--
-- Esta migration: limpa registros pré-existentes. O fix definitivo é
-- no endpoint cancel (commit acompanhante).
--
-- IMPORTANTE: caixa_fechamentos é snapshot imutável. Fechamentos já
-- gerados ficam com o total errado historicamente — o backfill só
-- garante que CONSULTAS futuras de sale_payments (relatórios live,
-- aba Fechamentos antes do snapshot do dia) deixem de inflar.
-- ============================================================

BEGIN;

-- Quantos registros vamos remover? (apenas diagnóstico no log)
DO $$
DECLARE
  v_count integer;
  v_total numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO v_count, v_total
  FROM sale_payments sp
  JOIN sales s ON s.id = sp.sale_id
  WHERE s.status = 'cancelled';

  RAISE NOTICE 'Migration 106: vai remover % sale_payments orfaos (total R$ %)', v_count, v_total;
END $$;

-- Limpa sale_payments cujas vendas foram canceladas.
-- Idempotente: rodar de novo é no-op.
DELETE FROM sale_payments sp
USING sales s
WHERE sp.sale_id = s.id
  AND s.status = 'cancelled';

COMMIT;
