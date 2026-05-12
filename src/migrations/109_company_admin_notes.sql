-- ========================================================================
-- Migration 109 · Company Admin Notes (CRM basico Gestao Aura)
-- Notas internas livres da equipe Aura por cliente.
-- Cada nota carrega autor (user_id) e timestamp.
-- ========================================================================

CREATE TABLE IF NOT EXISTS company_admin_notes (
  id             SERIAL PRIMARY KEY,
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES users(id),
  body           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_notes_company_created
  ON company_admin_notes (company_id, created_at DESC);
