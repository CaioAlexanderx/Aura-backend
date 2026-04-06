-- ============================================================
-- AURA. Migration 035 — Billing fields + webhook logs
-- Adds Asaas integration columns to companies table
-- ============================================================

-- Billing fields on companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS asaas_customer_id VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS asaas_subscription_id VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_status VARCHAR(20) DEFAULT 'trial';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS next_billing_date DATE;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_payment_date DATE;

CREATE INDEX IF NOT EXISTS idx_companies_asaas ON companies(asaas_customer_id);

COMMENT ON COLUMN companies.billing_status IS 'trial, active, overdue, cancelled, refunded, chargeback';

-- Webhook event log
CREATE TABLE IF NOT EXISTS webhook_logs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,
  provider      VARCHAR(30) NOT NULL,
  event         VARCHAR(60) NOT NULL,
  payload       JSONB,
  processed_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs ON webhook_logs(company_id, provider, processed_at DESC);
