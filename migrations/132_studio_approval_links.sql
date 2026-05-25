-- ============================================================
-- AURA Studio — Fase 5: Aprovação de arte via wa.me
-- 25/05/2026
-- ============================================================

CREATE TABLE IF NOT EXISTS studio_approval_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id        UUID NOT NULL REFERENCES digital_orders(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,
  mockup_url      TEXT DEFAULT NULL,
  message_text    TEXT DEFAULT NULL,
  customer_phone  TEXT DEFAULT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'changes_requested', 'expired')),
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  responded_at    TIMESTAMPTZ DEFAULT NULL,
  response_note   TEXT DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_approval_order
  ON studio_approval_links (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_approval_company_status
  ON studio_approval_links (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_approval_token
  ON studio_approval_links (token);

CREATE TABLE IF NOT EXISTS studio_approval_revisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id     UUID NOT NULL REFERENCES studio_approval_links(id) ON DELETE CASCADE,
  revision_number INT NOT NULL,
  mockup_url      TEXT DEFAULT NULL,
  note            TEXT DEFAULT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('shop', 'customer')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_studio_approval_rev
  ON studio_approval_revisions (approval_id, revision_number);
