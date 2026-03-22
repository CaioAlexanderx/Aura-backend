-- ============================================================
-- Migration 006 — Tabelas Gestão Aura (BE-17/18)
-- aura_operational_costs: custos operacionais da Aura
-- aura_revenue_snapshot: snapshot de MRR por plano
-- aura_team_members: equipe interna da Aura com permissões
-- ============================================================

-- BE-17: Custos operacionais da Aura
CREATE TABLE IF NOT EXISTS aura_operational_costs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  description TEXT NOT NULL,
  amount      NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  category    TEXT NOT NULL DEFAULT 'infra',
  recurrent   BOOLEAN NOT NULL DEFAULT true,
  reference_month DATE NOT NULL,
  notes       TEXT,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_aura_costs_month ON aura_operational_costs(reference_month);

-- BE-17: Snapshot de receita/MRR por plano
CREATE TABLE IF NOT EXISTS aura_revenue_snapshot (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reference_month DATE NOT NULL UNIQUE,
  clients_essencial   INTEGER DEFAULT 0,
  clients_negocio     INTEGER DEFAULT 0,
  clients_expansao    INTEGER DEFAULT 0,
  clients_total       INTEGER DEFAULT 0,
  mrr_essencial   NUMERIC(12,2) DEFAULT 0,
  mrr_negocio     NUMERIC(12,2) DEFAULT 0,
  mrr_expansao    NUMERIC(12,2) DEFAULT 0,
  mrr_total       NUMERIC(12,2) DEFAULT 0,
  mrr_addons      NUMERIC(12,2) DEFAULT 0,
  total_costs     NUMERIC(12,2) DEFAULT 0,
  gross_margin    NUMERIC(12,2) DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- BE-18: Equipe interna da Aura
CREATE TABLE IF NOT EXISTS aura_team_members (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile     TEXT NOT NULL CHECK (profile IN ('admin', 'analista', 'suporte', 'financeiro')),
  permissions JSONB NOT NULL DEFAULT '{}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

COMMENT ON COLUMN aura_team_members.permissions IS
  'Permissões granulares em JSONB. Ex: {"can_edit_plan": true, "can_view_financials": false}';
COMMENT ON TABLE aura_revenue_snapshot IS
  'Snapshot mensal de MRR. Fase 1: alimentado manualmente. Fase 2: via Asaas (pós-CNPJ).';
