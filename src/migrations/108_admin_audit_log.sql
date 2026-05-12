-- ========================================================================
-- Migration 108 · Admin Audit Log (Gestao Aura)
-- Tabela generica de auditoria para acoes administrativas executadas
-- pela equipe Aura. Reusable pra: extend_trial, apply_module_override,
-- change_plan, apply_discount, suspend, etc.
-- ========================================================================

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            SERIAL PRIMARY KEY,
  staff_user_id UUID NOT NULL REFERENCES users(id),
  company_id    UUID REFERENCES companies(id) ON DELETE SET NULL,
  action        VARCHAR(50) NOT NULL,   -- 'extend_trial' | 'apply_override' | etc.
  payload       JSONB,                  -- detalhes da acao (before/after/etc)
  reason        TEXT,                   -- motivo livre opcional informado pelo staff
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_company_created
  ON admin_audit_log (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_action_created
  ON admin_audit_log (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_staff_created
  ON admin_audit_log (staff_user_id, created_at DESC);
