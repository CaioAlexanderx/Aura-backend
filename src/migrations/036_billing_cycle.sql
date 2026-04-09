-- Migration 036: Add billing_cycle and asaas_pending_payment_id
-- Sprint 2: Hybrid checkout support

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS asaas_pending_payment_id VARCHAR(50);

-- Index for webhook lookup by pending payment
CREATE INDEX IF NOT EXISTS idx_companies_asaas_pending
  ON companies (asaas_pending_payment_id)
  WHERE asaas_pending_payment_id IS NOT NULL;

-- Webhook logs table (if not exists)
CREATE TABLE IF NOT EXISTS webhook_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL DEFAULT 'asaas',
  event VARCHAR(50) NOT NULL,
  payload JSONB,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_company
  ON webhook_logs (company_id, processed_at DESC);
