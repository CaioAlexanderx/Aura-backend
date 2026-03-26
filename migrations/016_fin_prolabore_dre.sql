-- ============================================================
-- AURA. — Migration 016: FIN-01 + FIN-02
-- Pró-labore, Fator R, DRE, Fluxo de Caixa Projetado
-- Aplicar manualmente no Supabase SQL Editor
-- ============================================================

-- ── 1. CONFIGURAÇÃO DE PRÓ-LABORE ─────────────────────────────
CREATE TABLE IF NOT EXISTS prolabore_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE UNIQUE,
  -- Valor fixo mensal definido pelo sócio
  fixed_amount    NUMERIC(12,2),
  -- OU percentual sobre a receita bruta do mês
  pct_of_revenue  NUMERIC(5,2),              -- ex: 28.00 = 28%
  -- Modo: 'fixed' | 'pct' | 'auto' (Aura calcula pelo Fator R)
  mode            TEXT NOT NULL DEFAULT 'auto'
    CHECK (mode IN ('fixed','pct','auto')),
  -- Meta do Fator R para ficar no Anexo III (28% é o mínimo)
  fator_r_target  NUMERIC(5,2) NOT NULL DEFAULT 28.00,
  -- INSS sobre pró-labore: obrigatório para sócio-administrador
  include_inss    BOOLEAN NOT NULL DEFAULT TRUE,
  inss_rate       NUMERIC(5,4) NOT NULL DEFAULT 0.11, -- 11% sobre o pró-labore
  -- Teto INSS 2026
  inss_cap        NUMERIC(12,2) NOT NULL DEFAULT 7786.02,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. HISTÓRICO DE PRÓ-LABORE TOMADO ────────────────────────
CREATE TABLE IF NOT EXISTS prolabore_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference_month DATE NOT NULL,             -- primeiro dia do mês
  amount          NUMERIC(12,2) NOT NULL,    -- valor bruto retirado
  inss_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount      NUMERIC(12,2) NOT NULL,    -- amount - inss_amount
  fator_r_result  NUMERIC(5,2),             -- Fator R calculado naquele mês
  gross_revenue   NUMERIC(12,2),            -- receita bruta do mês (snapshot)
  revenue_12m     NUMERIC(12,2),            -- receita 12 meses (snapshot)
  notes           TEXT,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, reference_month)
);

-- ── 3. CONFIGURAÇÃO DO DRE / CATEGORIAS ──────────────────────
-- Permite mapear categorias de lançamento para linhas do DRE
CREATE TABLE IF NOT EXISTS dre_category_map (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,             -- categoria livre do lançamento
  dre_line        TEXT NOT NULL,             -- linha do DRE: receita_bruta | deducoes | cogs | despesa_operacional | etc.
  dre_group       TEXT NOT NULL,             -- grupo para agrupamento no DRE
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, category)
);

CREATE INDEX IF NOT EXISTS idx_prolabore_history_company ON prolabore_history(company_id, reference_month DESC);
CREATE INDEX IF NOT EXISTS idx_dre_map_company           ON dre_category_map(company_id);

ALTER TABLE prolabore_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE prolabore_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE dre_category_map  ENABLE ROW LEVEL SECURITY;
