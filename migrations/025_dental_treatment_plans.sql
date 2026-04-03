-- ============================================================
-- AURA. Migration 025 — Dental Treatment Plans (D-02)
-- Orcamentos odontologicos com itens e parcelas
-- ============================================================

-- Status do orcamento
DO $$ BEGIN
  CREATE TYPE dental_plan_status AS ENUM (
    'rascunho', 'enviado', 'negociando', 'aprovado',
    'em_tratamento', 'concluido', 'recusado', 'cancelado'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Plano de tratamento / Orcamento
CREATE TABLE IF NOT EXISTS dental_treatment_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id    UUID NOT NULL REFERENCES dental_patients(id) ON DELETE CASCADE,
  plan_number   VARCHAR(30),
  status        dental_plan_status DEFAULT 'rascunho',
  subtotal      NUMERIC(12,2) DEFAULT 0,
  discount_pct  NUMERIC(5,2) DEFAULT 0,
  discount_amount NUMERIC(12,2) DEFAULT 0,
  total         NUMERIC(12,2) DEFAULT 0,
  notes         TEXT,
  valid_until   DATE,
  approved_at   TIMESTAMPTZ,
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_plans_company ON dental_treatment_plans(company_id);
CREATE INDEX IF NOT EXISTS idx_dental_plans_patient ON dental_treatment_plans(patient_id);
CREATE INDEX IF NOT EXISTS idx_dental_plans_status ON dental_treatment_plans(status);

-- Itens do plano (procedimentos)
CREATE TABLE IF NOT EXISTS dental_treatment_plan_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID NOT NULL REFERENCES dental_treatment_plans(id) ON DELETE CASCADE,
  procedure_id  UUID REFERENCES dental_procedures(id),
  procedure_name VARCHAR(200) NOT NULL,
  tooth_number  INTEGER,
  face          VARCHAR(10),
  price         NUMERIC(12,2) NOT NULL DEFAULT 0,
  status        VARCHAR(30) DEFAULT 'pendente',
  completed_at  TIMESTAMPTZ,
  notes         TEXT,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_plan_items ON dental_treatment_plan_items(plan_id);

-- Parcelas do orcamento
CREATE TABLE IF NOT EXISTS dental_treatment_plan_installments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id       UUID NOT NULL REFERENCES dental_treatment_plans(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  due_date      DATE NOT NULL,
  paid_at       TIMESTAMPTZ,
  payment_method VARCHAR(30),
  transaction_id UUID REFERENCES transactions(id),
  status        VARCHAR(20) DEFAULT 'pendente',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_installments ON dental_treatment_plan_installments(plan_id);

-- Auto-generate plan_number
CREATE OR REPLACE FUNCTION generate_dental_plan_number()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.plan_number IS NULL THEN
    NEW.plan_number := 'ORC-' || to_char(NOW(), 'YYYY') || '-' || 
      LPAD((SELECT COALESCE(COUNT(*),0)+1 FROM dental_treatment_plans WHERE company_id=NEW.company_id)::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dental_plan_number ON dental_treatment_plans;
CREATE TRIGGER trg_dental_plan_number
  BEFORE INSERT ON dental_treatment_plans
  FOR EACH ROW EXECUTE FUNCTION generate_dental_plan_number();
