-- ============================================================
-- AURA. Migration 028 — Dental Tier 2: Lab Orders + CRO
-- D-12: Lab/prosthetic orders
-- D-14: CRO number on professionals
-- ============================================================

-- D-12: Lab orders
CREATE TABLE IF NOT EXISTS dental_lab_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES dental_patients(id) ON DELETE CASCADE,
  plan_id         UUID REFERENCES dental_treatment_plans(id),
  lab_name        VARCHAR(200) NOT NULL,
  item_type       VARCHAR(100) NOT NULL,
  material        VARCHAR(100),
  tooth_number    INTEGER,
  shade           VARCHAR(20),
  cost            NUMERIC(12,2) DEFAULT 0,
  deadline        DATE,
  sent_at         TIMESTAMPTZ,
  received_at     TIMESTAMPTZ,
  status          VARCHAR(30) DEFAULT 'pendente',
  notes           TEXT,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_lab_company ON dental_lab_orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_dental_lab_patient ON dental_lab_orders(patient_id);

COMMENT ON COLUMN dental_lab_orders.status IS 'pendente, enviado, producao, pronto, entregue, refeito';
COMMENT ON COLUMN dental_lab_orders.item_type IS 'coroa, protocolo, provisorio, moldagem, placa_oclusal, aparelho, etc';

-- D-14: CRO number
ALTER TABLE users ADD COLUMN IF NOT EXISTS cro_number VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cro_state VARCHAR(2);
