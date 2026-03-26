-- ============================================================
-- AURA. — Migration 015: Onboarding + Checklist Mensal
-- CORE-01: sessões de onboarding com dados da RF cacheados
-- CORE-02: checklist mensal inteligente por regime + vertical
-- Aplicar manualmente no Supabase SQL Editor
-- ============================================================

-- ── 1. COLUNAS ADICIONAIS EM companies ───────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS onboarding_step          TEXT DEFAULT 'cnpj',
  -- CNAEs retornados pela RF (array JSON)
  ADD COLUMN IF NOT EXISTS cnaes                   JSONB,
  -- Natureza jurídica (código + descrição)
  ADD COLUMN IF NOT EXISTS legal_nature            TEXT,
  ADD COLUMN IF NOT EXISTS legal_nature_code       TEXT,
  -- Porte: MEI | ME | EPP | DEMAIS
  ADD COLUMN IF NOT EXISTS company_size            TEXT,
  -- Dados de endereço vindos da RF (podem ser sobrescritos pelo usuário)
  ADD COLUMN IF NOT EXISTS address_street          TEXT,
  ADD COLUMN IF NOT EXISTS address_number          TEXT,
  ADD COLUMN IF NOT EXISTS address_complement      TEXT,
  ADD COLUMN IF NOT EXISTS address_district        TEXT,
  ADD COLUMN IF NOT EXISTS address_city            TEXT,
  ADD COLUMN IF NOT EXISTS address_state           CHAR(2),
  ADD COLUMN IF NOT EXISTS address_zip             TEXT,
  -- Dados fiscais da RF
  ADD COLUMN IF NOT EXISTS tax_id                  TEXT, -- CNPJ formatado
  ADD COLUMN IF NOT EXISTS opening_date            DATE,
  ADD COLUMN IF NOT EXISTS rf_situation            TEXT; -- ATIVA | SUSPENSA | INAPTA | BAIXADA

-- ── 2. SESSÕES DE ONBOARDING ─────────────────────────────────
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Etapas: cnpj → regime → perfil → vertical → done
  current_step TEXT NOT NULL DEFAULT 'cnpj',
  -- Snapshot dos dados RF para não re-consultar
  rf_data      JSONB,
  -- Flags de etapas concluídas
  step_cnpj_done      BOOLEAN NOT NULL DEFAULT FALSE,
  step_regime_done    BOOLEAN NOT NULL DEFAULT FALSE,
  step_perfil_done    BOOLEAN NOT NULL DEFAULT FALSE,
  step_vertical_done  BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id)
);

-- ── 3. CHECKLIST MENSAL ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS monthly_checklist (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Mês de referência: primeiro dia do mês
  reference_month DATE NOT NULL,
  -- Identificador do item (único por empresa+mês+código)
  code            TEXT NOT NULL,   -- ex: DAS_MEI | PGDAS_D | FGTS | ESOCIAL | COMISSOES
  category        TEXT NOT NULL,   -- fiscal | trabalhista | operacional | vertical
  title           TEXT NOT NULL,
  description     TEXT,
  due_date        DATE,
  -- Regime/vertical que gera este item
  applies_to_regime   TEXT,        -- mei | simples_nacional | NULL (todos)
  applies_to_vertical TEXT,        -- odonto | salao | NULL (todos)
  -- Estado
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','done','skipped','overdue')),
  done_at         TIMESTAMPTZ,
  done_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT,
  -- Streak e gamificação (agregado no GET, não armazenado por item)
  is_required     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      SMALLINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, reference_month, code)
);

CREATE INDEX IF NOT EXISTS idx_checklist_company_month
  ON monthly_checklist(company_id, reference_month DESC);
CREATE INDEX IF NOT EXISTS idx_checklist_status
  ON monthly_checklist(company_id, status);
CREATE INDEX IF NOT EXISTS idx_onboarding_company
  ON onboarding_sessions(company_id);

ALTER TABLE onboarding_sessions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_checklist     ENABLE ROW LEVEL SECURITY;
