-- ============================================================
-- AURA. — Migration 408: cobranças da assinatura Aura (tq-77, tq-78,
-- tq-84, tq-86, tq-93 — 24/10/2026)
--
-- Espelho local das cobranças da assinatura Aura na Asaas, uma linha por
-- cobrança (pay_...). Alimentado pelo webhook (src/routes/webhookAsaas.js
-- -> services/cobrancaAssinatura.js) e pela varredura diária das cobranças
-- pendentes (jobs/reguaDeCobrancaJob.js). É a fonte de:
--
--   - billing_overdue_since do /auth/me (tq-86): o vencimento da cobrança
--     OVERDUE mais antiga da empresa; a pausa das telas é +7 dias e a do
--     Caixa +14 (DIAS_ATE_PAUSA_TELAS / DIAS_ATE_PAUSA_CAIXA);
--   - lembrete 2 dias antes e no dia (tq-77), régua de atraso de 1, 3, 7,
--     11 e 14 dias (tq-78, tq-93) e cartão recusado (tq-84).
--
-- A data NUNCA vem de companies.next_billing_date (que o trigger da 393 e a
-- correção de vencimentos mexem): vem do dueDate da própria cobrança.
--
--   status   PENDING | OVERDUE | PAID | REFUNDED | CHARGEBACK | DELETED
--            (PAID/REFUNDED/DELETED não voltam para PENDING/OVERDUE com
--            evento atrasado ou reenviado)
--
-- Backfill: cobranças com PAYMENT_OVERDUE em webhook_logs, de empresa hoje
-- 'overdue', sem evento posterior de pagamento, estorno ou exclusão da mesma
-- cobrança. Em 24/10/2026 era 1 empresa (vencimento 20/10).
--
-- Idempotente. Sem política de RLS: só o backend (service role).
-- ============================================================

CREATE TABLE IF NOT EXISTS assinatura_cobrancas (
  asaas_payment_id       TEXT        PRIMARY KEY,
  company_id             UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asaas_subscription_id  TEXT,
  status                 TEXT        NOT NULL
                                     CHECK (status IN ('PENDING', 'OVERDUE', 'PAID', 'REFUNDED', 'CHARGEBACK', 'DELETED')),
  due_date               DATE        NOT NULL,
  valor                  NUMERIC(12,2),
  billing_type           TEXT,
  invoice_url            TEXT,
  cartao_final           TEXT,
  vencida_em             TIMESTAMPTZ,
  paga_em                TIMESTAMPTZ,
  data_pagamento         DATE,
  cartao_recusado_em     TIMESTAMPTZ,
  retentativa_em         TIMESTAMPTZ,
  retentativa_resultado  TEXT,
  origem                 TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assinatura_cobrancas_vencidas
  ON assinatura_cobrancas (company_id, due_date)
  WHERE status = 'OVERDUE';

CREATE INDEX IF NOT EXISTS idx_assinatura_cobrancas_pendentes
  ON assinatura_cobrancas (due_date)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_assinatura_cobrancas_cartao
  ON assinatura_cobrancas (cartao_recusado_em)
  WHERE cartao_recusado_em IS NOT NULL AND retentativa_em IS NULL;

ALTER TABLE assinatura_cobrancas ENABLE ROW LEVEL SECURITY;

-- Backfill das cobranças em atraso a partir de webhook_logs.
INSERT INTO assinatura_cobrancas
  (asaas_payment_id, company_id, asaas_subscription_id, status, due_date, valor,
   billing_type, invoice_url, vencida_em, origem)
SELECT DISTINCT ON (y.pid)
       y.pid, w.company_id, x.p->>'subscription', 'OVERDUE', (x.p->>'dueDate')::date,
       CASE WHEN (x.p->>'value') ~ '^[0-9]+(\.[0-9]+)?$' THEN (x.p->>'value')::numeric END,
       x.p->>'billingType', x.p->>'invoiceUrl', w.processed_at, 'backfill'
  FROM webhook_logs w
  CROSS JOIN LATERAL (SELECT COALESCE(w.payload->'payment', w.payload) AS p) x
  CROSS JOIN LATERAL (SELECT x.p->>'id' AS pid) y
  JOIN companies c ON c.id = w.company_id
 WHERE w.provider = 'asaas'
   AND w.event = 'PAYMENT_OVERDUE'
   AND w.company_id IS NOT NULL
   AND y.pid IS NOT NULL
   AND (x.p->>'dueDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND COALESCE(x.p->>'externalReference', '') NOT LIKE 'digital-order-%'
   AND COALESCE(x.p->>'externalReference', '') NOT LIKE 'wa-pack-%'
   AND c.billing_status::text = 'overdue'
   AND NOT EXISTS (
         SELECT 1 FROM webhook_logs w2
          WHERE w2.provider = 'asaas'
            AND w2.event IN ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED', 'PAYMENT_REFUNDED',
                             'PAYMENT_DELETED', 'PAYMENT_CHARGEBACK_REQUESTED')
            AND COALESCE(w2.payload->'payment', w2.payload)->>'id' = y.pid)
 ORDER BY y.pid, w.processed_at DESC
ON CONFLICT (asaas_payment_id) DO NOTHING;
