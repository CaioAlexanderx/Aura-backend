-- ========================================================================
-- Migration 103 · Report Deliveries
-- Registra cada entrega de relatorio (semanal/mensal).
-- Usado para idempotencia (evitar reenvio) e auditoria.
-- ========================================================================

CREATE TABLE IF NOT EXISTS report_deliveries (
  id             SERIAL PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_type    VARCHAR(10) NOT NULL CHECK (report_type IN ('weekly', 'monthly')),
  period_start   DATE NOT NULL,
  status         VARCHAR(20) NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'failed')),
  resend_id      VARCHAR(100),
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_deliveries_company_type_period
  ON report_deliveries (company_id, report_type, period_start);

CREATE INDEX IF NOT EXISTS idx_report_deliveries_status
  ON report_deliveries (status)
  WHERE status != 'sent';
