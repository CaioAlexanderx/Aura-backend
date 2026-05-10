-- ========================================================================
-- Migration 102 · Company Health Snapshots
-- Armazena snapshot mensal do health score por empresa.
-- Usado pelo relatorio mensal para mostrar evolucao de 6 meses.
-- ========================================================================

CREATE TABLE IF NOT EXISTS company_health_snapshots (
  id                   SERIAL PRIMARY KEY,
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  score                INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  label                VARCHAR(20),
  period               DATE NOT NULL,
  driver_margem        INTEGER,
  driver_runway        INTEGER,
  driver_crescimento   INTEGER,
  driver_ticket        INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_health_snapshot UNIQUE (company_id, period)
);

CREATE INDEX IF NOT EXISTS idx_health_snapshots_company_period
  ON company_health_snapshots (company_id, period DESC);
