-- ============================================================
-- 382 — SNAPSHOT MENSAL COM CUSTO REAL (aura_revenue_snapshot)
--
-- Contexto (13/10/2026, pedido da Financeiro, aval do Caio): o snapshot
-- mensal so tinha clientes e MRR; custo e margem ficaram em abril (digitado)
-- e zerados em outubro. O DRE precisa de custo real por mes, separado do que
-- o painel recalcula todo dia.
--
-- Colunas novas (todas opcionais, nada existente muda):
--   taxas_asaas     taxas cobradas pela Asaas no mes (saem do extrato).
--   das             DAS declarado do mes (Simples).
--   custos_detalhe  jsonb com os custos por categoria e a origem de cada um.
--
-- total_costs continua SEM DAS e SEM taxas; gross_margin = mrr_total - total_costs.
-- O resultado depois de taxas e DAS e calculado na leitura
-- (mrr_total - total_costs - taxas_asaas - das), nao fica em coluna.
--
-- Escrita dos meses de maio a setembro/2026 (upsert por reference_month):
-- sao os unicos meses sem linha. Outubro NAO e tocado: o job do painel
-- recalcula clients_* e mrr_* (services/receita.gravarSnapshot) e nao mexe
-- em custos. Abril fica como esta (estimativa digitada), so ganha a nota.
--
-- Metodo de MRR e clientes dos meses passados: cobrancas recebidas com
-- vencimento no mes, cupom a valor cheio; clientes = lojas com cobranca
-- recebida no mes (webhook_logs da Asaas e extrato OFX). Difere do MRR
-- contratual, que so existe a partir de outubro.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, upsert e UPDATE condicional.
-- ============================================================

ALTER TABLE aura_revenue_snapshot
  ADD COLUMN IF NOT EXISTS taxas_asaas    NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS das            NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS custos_detalhe JSONB;

COMMENT ON COLUMN aura_revenue_snapshot.taxas_asaas IS
  'Taxas da Asaas no mes (extrato). Fora de total_costs.';
COMMENT ON COLUMN aura_revenue_snapshot.das IS
  'DAS declarado do mes. Fora de total_costs.';
COMMENT ON COLUMN aura_revenue_snapshot.custos_detalhe IS
  'Custos do mes por categoria, cada um com valor e origem. A soma e total_costs.';

-- Cada linha: mes, clientes (ess/neg/exp), MRR (ess/neg/exp/addons/total),
-- custos (total e a parte da Anthropic, paga em conta pessoal do socio),
-- taxas da Asaas e DAS.
INSERT INTO aura_revenue_snapshot (
  reference_month,
  clients_essencial, clients_negocio, clients_expansao, clients_total,
  mrr_essencial, mrr_negocio, mrr_expansao, mrr_addons, mrr_total,
  total_costs, gross_margin, taxas_asaas, das, custos_detalhe, notes
)
SELECT
  v.mes,
  v.c_ess, v.c_neg, v.c_exp, v.c_ess + v.c_neg + v.c_exp,
  v.m_ess, v.m_neg, 0, v.addons, v.m_ess + v.m_neg + v.addons,
  v.custos, (v.m_ess + v.m_neg + v.addons) - v.custos, v.taxas, v.das,
  jsonb_build_object(
    'anthropic', jsonb_build_object(
      'valor', 550.00,
      'origem', 'socio',
      'observacao', 'paga em conta pessoal do socio'),
    'demais', jsonb_build_object(
      'valor', v.custos - 550.00,
      'observacao', 'sem abertura por categoria neste snapshot')
  ),
  'Custo real lancado em 13/10/2026. total_costs sem DAS e sem taxas da Asaas; '
  || 'cada mes inclui R$ 550 da Anthropic paga em conta pessoal (origem: socio). '
  || 'MRR e clientes = cobrancas recebidas com vencimento no mes, cupom a valor cheio; '
  || 'clientes = lojas com cobranca recebida no mes (webhook_logs da Asaas e OFX); '
  || 'difere do MRR contratual. Retirada KSCHEPISSTORE fora do custo. '
  || 'Provisorio ate a retificacao do PGDAS e o fechamento de outubro (03/11).'
FROM (VALUES
  --  mes           c_ess c_neg c_exp m_ess  m_neg   addons custos   taxas  das
  ('2026-05-01'::date, 1,  2,  0,  74.17, 282.41, 19.00, 1026.18,  6.96, NULL::numeric),
  ('2026-06-01'::date, 1,  4,  0,  74.17, 564.82,  0.00, 1023.56, 12.38, 59.00),
  ('2026-07-01'::date, 1,  5,  0,  74.17, 733.07, 19.00,  844.40, 27.76, 38.34),
  ('2026-08-01'::date, 1,  4,  0,  74.17, 592.24, 19.00,  796.46, 20.95, 45.58),
  ('2026-09-01'::date, 1,  7,  0,  74.17, 1042.90, 19.00, 871.17, 26.95, 45.34)
) AS v(mes, c_ess, c_neg, c_exp, m_ess, m_neg, addons, custos, taxas, das)
ON CONFLICT (reference_month) DO UPDATE SET
  clients_essencial = EXCLUDED.clients_essencial,
  clients_negocio   = EXCLUDED.clients_negocio,
  clients_expansao  = EXCLUDED.clients_expansao,
  clients_total     = EXCLUDED.clients_total,
  mrr_essencial     = EXCLUDED.mrr_essencial,
  mrr_negocio       = EXCLUDED.mrr_negocio,
  mrr_expansao      = EXCLUDED.mrr_expansao,
  mrr_addons        = EXCLUDED.mrr_addons,
  mrr_total         = EXCLUDED.mrr_total,
  total_costs       = EXCLUDED.total_costs,
  gross_margin      = EXCLUDED.gross_margin,
  taxas_asaas       = EXCLUDED.taxas_asaas,
  das               = EXCLUDED.das,
  custos_detalhe    = EXCLUDED.custos_detalhe,
  notes             = EXCLUDED.notes,
  updated_at        = NOW();

-- Abril: o snapshot foi digitado, sem pagamento por tras. Mantem os numeros
-- e marca na nota.
UPDATE aura_revenue_snapshot
   SET notes = COALESCE(notes, '') || ' | Estimativa digitada, sem pagamento por tras (nota de 13/10/2026).',
       updated_at = NOW()
 WHERE reference_month = '2026-04-01'
   AND COALESCE(notes, '') NOT LIKE '%Estimativa digitada%';
