-- ============================================================
-- AURA. — W3 Sprint 1 F1: IMPLANTODONTIA
--
-- Aplicada em producao via MCP Supabase em 25/04/2026.
-- Arquivo espelho criado conforme regra de migration da sessao
-- (toda apply_migration via MCP DEVE ter .sql no repo pra CI).
--
-- Fluxo clinico (~6 meses):
--   1. Avaliacao + planejamento (panoramica, tomo)
--   2. Cirurgia de instalacao (pino de titanio no osso)
--   3. Osseointegracao (3-6 meses)
--   4. Reabertura + cicatrizador (se 2 estagios)
--   5. Moldagem
--   6. Instalacao da protese (coroa)
--   7. Follow-up
--
-- 4 tabelas:
--   dental_implant_brands       - catalogo (NULL=global, NOT NULL=custom)
--   dental_implant_treatments   - tratamento (1 paciente -> N implantes)
--   dental_implants             - pino individual instalado (rastreabilidade ANVISA)
--   dental_implant_phases       - etapas do fluxo
-- ============================================================

CREATE TABLE IF NOT EXISTS dental_implant_brands (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        REFERENCES companies(id) ON DELETE CASCADE,
  name          varchar(80) NOT NULL,
  manufacturer  varchar(80),
  country       varchar(40),
  notes         text,
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_implant_brands_company
  ON dental_implant_brands(company_id) WHERE is_active = true;

INSERT INTO dental_implant_brands (name, manufacturer, country, notes) VALUES
  ('Neodent',       'Straumann Group',     'Brasil',  'Maior fabricante brasileiro, lider de mercado'),
  ('Straumann',     'Straumann AG',        'Suica',   'Premium global, alta osseointegracao'),
  ('Nobel Biocare', 'Envista',             'Suica',   'Pioneira em implantes osseointegrados'),
  ('SIN',           'SIN Implant System',  'Brasil',  'Brasileira, custo-beneficio'),
  ('Conexao',       'Conexao Sistemas',    'Brasil',  'Brasileira, ampla linha'),
  ('Titanium Fix',  'AS Technology',       'Brasil',  'Brasileira'),
  ('Implacil',      'Implacil De Bortoli', 'Brasil',  'Brasileira'),
  ('BTI',           'BTI Biotechnology',   'Espanha', 'Implantes curtos especializados')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS dental_implant_treatments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id         uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  practitioner_id     uuid        REFERENCES dental_practitioners(id) ON DELETE SET NULL,
  treatment_plan_id   uuid,
  treatment_number    varchar(20) NOT NULL,
  status              varchar(20) NOT NULL DEFAULT 'planning',
  diagnosis           text,
  surgical_plan       text,
  surgery_type        varchar(30),
  uses_graft          boolean     NOT NULL DEFAULT false,
  graft_type          varchar(40),
  graft_notes         text,
  consultation_date   date,
  surgery_date        date,
  expected_completion date,
  completed_at        timestamptz,
  abandoned_at        timestamptz,
  abandon_reason      text,
  total_value         numeric(12, 2),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, treatment_number)
);

CREATE INDEX IF NOT EXISTS idx_implant_treatments_customer
  ON dental_implant_treatments(company_id, customer_id, status);
CREATE INDEX IF NOT EXISTS idx_implant_treatments_status
  ON dental_implant_treatments(company_id, status, surgery_date DESC);

CREATE TABLE IF NOT EXISTS dental_implants (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  treatment_id      uuid        NOT NULL REFERENCES dental_implant_treatments(id) ON DELETE CASCADE,
  customer_id       uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tooth_number      smallint    NOT NULL CHECK (tooth_number BETWEEN 11 AND 48),
  brand_id          uuid        REFERENCES dental_implant_brands(id) ON DELETE SET NULL,
  brand_name        varchar(80),
  model             varchar(80),
  size_diameter_mm  numeric(3, 1),
  size_length_mm    numeric(4, 1),
  platform          varchar(20),
  lot_number        varchar(80),
  expiry_date       date,
  installed_at      timestamptz,
  surgeon_id        uuid        REFERENCES dental_practitioners(id) ON DELETE SET NULL,
  insertion_torque  numeric(4, 1),
  primary_stability varchar(20),
  surgery_notes     text,
  status            varchar(20) NOT NULL DEFAULT 'planned',
  failed_at         timestamptz,
  fail_reason       text,
  removed_at        timestamptz,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  updated_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_implants_treatment ON dental_implants(treatment_id);
CREATE INDEX IF NOT EXISTS idx_implants_customer  ON dental_implants(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_implants_lot       ON dental_implants(lot_number) WHERE lot_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS dental_implant_phases (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  treatment_id    uuid        NOT NULL REFERENCES dental_implant_treatments(id) ON DELETE CASCADE,
  phase_number    smallint    NOT NULL,
  kind            varchar(30) NOT NULL,
  title           varchar(120) NOT NULL,
  description     text,
  planned_date    date,
  completed_date  timestamptz,
  status          varchar(20) NOT NULL DEFAULT 'planned',
  appointment_id  uuid        REFERENCES dental_appointments(id) ON DELETE SET NULL,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (treatment_id, phase_number)
);

CREATE INDEX IF NOT EXISTS idx_implant_phases_treatment
  ON dental_implant_phases(treatment_id, phase_number);
CREATE INDEX IF NOT EXISTS idx_implant_phases_status
  ON dental_implant_phases(status, planned_date)
  WHERE status IN ('planned', 'in_progress', 'delayed');

CREATE OR REPLACE FUNCTION update_implant_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_implant_treatments_updated_at ON dental_implant_treatments;
CREATE TRIGGER trg_implant_treatments_updated_at
  BEFORE UPDATE ON dental_implant_treatments
  FOR EACH ROW EXECUTE FUNCTION update_implant_updated_at();

DROP TRIGGER IF EXISTS trg_implants_updated_at ON dental_implants;
CREATE TRIGGER trg_implants_updated_at
  BEFORE UPDATE ON dental_implants
  FOR EACH ROW EXECUTE FUNCTION update_implant_updated_at();

DROP TRIGGER IF EXISTS trg_implant_phases_updated_at ON dental_implant_phases;
CREATE TRIGGER trg_implant_phases_updated_at
  BEFORE UPDATE ON dental_implant_phases
  FOR EACH ROW EXECUTE FUNCTION update_implant_updated_at();

CREATE OR REPLACE FUNCTION implant_treatment_next_number(p_company_id uuid)
RETURNS varchar AS $$
DECLARE
  v_seq int;
  v_today varchar;
BEGIN
  v_today := to_char(CURRENT_DATE, 'YYYYMMDD');
  SELECT COALESCE(COUNT(*), 0) + 1 INTO v_seq
    FROM dental_implant_treatments
   WHERE company_id = p_company_id
     AND treatment_number LIKE 'IMP-' || v_today || '-%';
  RETURN 'IMP-' || v_today || '-' || lpad(v_seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;
