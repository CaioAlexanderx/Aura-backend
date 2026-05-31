-- ============================================================
-- 124_sales_crm_phase2
-- CRM Comercial — Fase 2: valor potencial, cadencias, metas
-- ============================================================

ALTER TABLE sales_leads
  ADD COLUMN IF NOT EXISTS expected_plan  TEXT CHECK (expected_plan IN ('essencial','negocio','expansao')),
  ADD COLUMN IF NOT EXISTS cadence_name   TEXT,
  ADD COLUMN IF NOT EXISTS cadence_day    INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rotten_since   TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS lead_cadences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  steps       JSONB NOT NULL DEFAULT '[]',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_goals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_month  DATE NOT NULL,
  target_contacts  INT NOT NULL DEFAULT 0,
  target_converted INT NOT NULL DEFAULT 0,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (reference_month)
);

INSERT INTO lead_cadences (name, description, steps) VALUES
('Ativo 5 dias','Cadencia curta para leads quentes','[{"day":0,"action":"whatsapp","note":"Mensagem inicial"},{"day":2,"action":"sem_resposta","note":"Follow-up"},{"day":5,"action":"ligacao","note":"Ligar"}]'::jsonb),
('Nutricao 14 dias','Cadencia media para leads mornos','[{"day":0,"action":"whatsapp","note":"Primeiro contato"},{"day":3,"action":"sem_resposta","note":"Follow-up 1"},{"day":7,"action":"whatsapp","note":"Follow-up 2"},{"day":14,"action":"ligacao","note":"Ultima tentativa"}]'::jsonb),
('Re-engajamento','Para leads que nao responderam','[{"day":0,"action":"whatsapp","note":"Reativacao"},{"day":5,"action":"whatsapp","note":"Ultima tentativa"}]'::jsonb)
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_sales_leads_expected_plan ON sales_leads(expected_plan) WHERE expected_plan IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_leads_rotten        ON sales_leads(rotten_since)   WHERE rotten_since IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_goals_month          ON lead_goals(reference_month);

CREATE OR REPLACE FUNCTION set_updated_at_generic()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_lead_cadences_updated_at ON lead_cadences;
CREATE TRIGGER trg_lead_cadences_updated_at BEFORE UPDATE ON lead_cadences FOR EACH ROW EXECUTE FUNCTION set_updated_at_generic();

DROP TRIGGER IF EXISTS trg_lead_goals_updated_at ON lead_goals;
CREATE TRIGGER trg_lead_goals_updated_at BEFORE UPDATE ON lead_goals FOR EACH ROW EXECUTE FUNCTION set_updated_at_generic();
