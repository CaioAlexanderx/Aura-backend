-- Migration 039: WhatsApp Cloud API config per company
-- Sprint 5: Each client connects their own WhatsApp number

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS wa_waba_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS wa_phone_number_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS wa_phone_display VARCHAR(20),
  ADD COLUMN IF NOT EXISTS wa_access_token TEXT,
  ADD COLUMN IF NOT EXISTS wa_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS wa_connected_at TIMESTAMPTZ;

-- WhatsApp message log
CREATE TABLE IF NOT EXISTS wa_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL DEFAULT 'outbound',
  wa_message_id VARCHAR(100),
  to_phone VARCHAR(20),
  from_phone VARCHAR(20),
  template_name VARCHAR(100),
  content TEXT,
  status VARCHAR(20) DEFAULT 'sent',
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_messages_company ON wa_messages (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_status ON wa_messages (company_id, status);
