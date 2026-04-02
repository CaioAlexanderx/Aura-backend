-- ============================================================
-- AURA. Migration 022 — AI Activity Log
-- Tracks all AI agent actions per company
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_activity_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  agent       VARCHAR(30) NOT NULL DEFAULT 'geral',
  action      VARCHAR(100) NOT NULL,
  detail      TEXT,
  status      VARCHAR(20) DEFAULT 'done' CHECK (status IN ('done', 'pending', 'info', 'error')),
  metadata    JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_activity_company ON ai_activity_log(company_id);
CREATE INDEX IF NOT EXISTS idx_ai_activity_agent ON ai_activity_log(agent);
CREATE INDEX IF NOT EXISTS idx_ai_activity_created ON ai_activity_log(created_at DESC);
