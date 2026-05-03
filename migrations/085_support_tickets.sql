-- ============================================================
-- AURA. -- Mirror SQL: support_tickets
-- Drift fix: tabela existia em prod via Supabase MCP sem mirror.
-- Data do mirror: 03/05/2026 (Multi-CNPJ Sessao 2 closeout).
-- Ja aplicado em prod; este arquivo existe apenas para CI.
--
-- Suporte ao tab "Seu Analista de Negocios" (FE-31).
-- Categoria 'suporte' default; status: aberto/em_andamento/resolvido/fechado.
-- Prioridade: baixa/normal/alta/urgente.
-- ============================================================

CREATE TABLE IF NOT EXISTS support_tickets (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id   UUID NOT NULL REFERENCES companies(id),
  user_id      UUID NOT NULL REFERENCES users(id),
  subject      TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'suporte',
  priority     TEXT NOT NULL DEFAULT 'normal',
  status       TEXT NOT NULL DEFAULT 'aberto',
  assigned_to  UUID REFERENCES users(id),
  metadata     JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_company
  ON support_tickets (company_id, status, created_at DESC);
