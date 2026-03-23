-- ============================================================
-- Migration 009 — Multi-usuário RBAC Estendido (BE-09)
-- R$19/membro adicional/mês · Plano mínimo: Negócio
-- ============================================================

CREATE TABLE IF NOT EXISTS role_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  permissions JSONB NOT NULL DEFAULT '{}',
  is_default  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, name)
);

CREATE INDEX idx_role_templates_company ON role_templates(company_id);

ALTER TABLE company_members
  ADD COLUMN IF NOT EXISTS template_id   UUID REFERENCES role_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invited_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS invited_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invite_token  TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS invite_email  TEXT,
  ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('pending', 'active', 'suspended'));

CREATE INDEX idx_members_invite_token ON company_members(invite_token) WHERE invite_token IS NOT NULL;

COMMENT ON TABLE role_templates IS
  'Templates de permissão. company_id NULL = templates globais Aura. Empresa pode criar os próprios.';
COMMENT ON COLUMN company_members.status IS
  'pending = convite enviado; active = membro ativo; suspended = acesso suspenso';
