-- ============================================================
-- Migration 101 — Member Audit Log
-- ============================================================
-- Sprint 4 da revisao UX da Equipe (06/05/2026): rastreia toda
-- mudanca em company_members pra dono ver "quem fez o que e quando"
-- (Eryca relatou perder controle de quem convidou quem em multi-CNPJ).
--
-- Actions registradas:
--   invite_created, invite_resent, invite_email_changed, invite_extended,
--   invite_accepted, invite_cancelled, member_suspended,
--   permissions_updated, role_changed, companies_changed
-- ============================================================

CREATE TABLE IF NOT EXISTS member_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- member_id NULLABLE pra preservar log apos DELETE (cancelamento real)
  member_id UUID,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(40) NOT NULL,
  -- metadata: snapshot do que mudou (old/new email, perms diff, etc)
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_member_audit_member  ON member_audit_log(member_id, created_at DESC) WHERE member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_member_audit_company ON member_audit_log(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_member_audit_actor   ON member_audit_log(actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL;

COMMENT ON TABLE member_audit_log IS 'Auditoria de mudancas em company_members — invite/resend/edit/cancel/perm-update';
COMMENT ON COLUMN member_audit_log.member_id IS 'Pode ficar NULL apos DELETE do member pra preservar historico';
COMMENT ON COLUMN member_audit_log.metadata IS 'Snapshot do que mudou: { old_email, new_email, perms_diff, etc }';
