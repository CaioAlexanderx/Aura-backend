-- ============================================================
-- AURA. -- Mirror SQL: sales_goals
-- Drift fix: tabela existia em prod via Supabase MCP sem mirror.
-- Data do mirror: 03/05/2026 (Multi-CNPJ Sessao 2 closeout).
-- Ja aplicado em prod; este arquivo existe apenas para CI rodar
-- em DB limpo (`ls migrations/*.sql | sort`).
-- ============================================================

CREATE TABLE IF NOT EXISTS sales_goals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id     UUID REFERENCES employees(id) ON DELETE CASCADE,
  period          VARCHAR NOT NULL,
  target_revenue  NUMERIC DEFAULT 0,
  target_units    INTEGER DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),

  -- Garante 1 meta por (company, employee, period). Quando employee_id e
  -- NULL, e meta global da empresa (single row por period via partial idx).
  CONSTRAINT sales_goals_company_id_employee_id_period_key
    UNIQUE (company_id, employee_id, period)
);

CREATE INDEX IF NOT EXISTS idx_sales_goals_company_period
  ON sales_goals (company_id, period);

-- Meta global (employee_id IS NULL): apenas uma por (company, period)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_goals_global
  ON sales_goals (company_id, period)
  WHERE employee_id IS NULL;
