-- ============================================================
-- AURA. Migration 033 — S11: Dental Tier 3 (Premium)
-- D-16: Convênios + TUSS, D-17: TISS guides
-- D-18: Specialty forms, D-19: Periodontal chart
-- D-20: Waitlist, D-21: Check-in
-- ============================================================

-- D-16: Dental insurance (convênios)
CREATE TABLE IF NOT EXISTS dental_insurance (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  registration  VARCHAR(30),
  ans_code      VARCHAR(10),
  contact_phone VARCHAR(20),
  contact_email VARCHAR(200),
  default_discount_pct NUMERIC(5,2) DEFAULT 0,
  payment_deadline_days INTEGER DEFAULT 30,
  is_active     BOOLEAN DEFAULT true,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_insurance ON dental_insurance(company_id, is_active);

-- D-16: TUSS procedure codes
CREATE TABLE IF NOT EXISTS dental_tuss_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(20) NOT NULL UNIQUE,
  description   TEXT NOT NULL,
  specialty     VARCHAR(50),
  default_price NUMERIC(12,2) DEFAULT 0,
  is_active     BOOLEAN DEFAULT true
);

COMMENT ON COLUMN dental_tuss_codes.specialty IS 'geral, ortodontia, endodontia, periodontia, cirurgia, protese, implante, odontopediatria';

-- D-16: Insurance procedure pricing
CREATE TABLE IF NOT EXISTS dental_insurance_procedures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  insurance_id  UUID NOT NULL REFERENCES dental_insurance(id) ON DELETE CASCADE,
  tuss_code     VARCHAR(20) NOT NULL,
  tuss_description TEXT,
  covered_price NUMERIC(12,2) NOT NULL,
  requires_auth BOOLEAN DEFAULT false,
  auth_deadline_days INTEGER DEFAULT 5,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_ins_proc ON dental_insurance_procedures(insurance_id);

-- D-17: TISS guides (Guia de Tratamento Odontológico)
CREATE TABLE IF NOT EXISTS dental_tiss_guides (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id    UUID NOT NULL REFERENCES dental_patients(id),
  insurance_id  UUID NOT NULL REFERENCES dental_insurance(id),
  treatment_plan_id UUID,
  guide_number  VARCHAR(20),
  guide_type    VARCHAR(30) DEFAULT 'gto',
  status        VARCHAR(20) DEFAULT 'rascunho',
  procedures    JSONB NOT NULL DEFAULT '[]',
  total_value   NUMERIC(12,2) DEFAULT 0,
  authorized_value NUMERIC(12,2),
  authorized_at TIMESTAMPTZ,
  denied_reason TEXT,
  xml_content   TEXT,
  xml_url       TEXT,
  pdf_url       TEXT,
  sent_at       TIMESTAMPTZ,
  professional_id UUID,
  professional_cro VARCHAR(20),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_tiss ON dental_tiss_guides(company_id, status);
COMMENT ON COLUMN dental_tiss_guides.guide_type IS 'gto (tratamento), sp_sadt (servico prof), consulta';
COMMENT ON COLUMN dental_tiss_guides.status IS 'rascunho, enviada, autorizada, parcial, negada, executada, glosada';

-- D-18: Specialty forms
CREATE TABLE IF NOT EXISTS dental_specialty_forms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES dental_patients(id),
  specialty       VARCHAR(30) NOT NULL,
  form_data       JSONB NOT NULL DEFAULT '{}',
  professional_id UUID,
  appointment_id  UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_spec ON dental_specialty_forms(patient_id, specialty);
COMMENT ON COLUMN dental_specialty_forms.specialty IS 'ortodontia, endodontia, periodontia, cirurgia, implante, protese';
COMMENT ON COLUMN dental_specialty_forms.form_data IS 'JSON structure varies by specialty: orto={class, overjet, overbite, aligner_type, stage}, endo={tooth, canals[], working_length, files_used}, perio=use dental_periodontal_chart';

-- D-19: Periodontal chart (sondagem)
CREATE TABLE IF NOT EXISTS dental_periodontal_chart (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES dental_patients(id),
  professional_id UUID,
  exam_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  measurements    JSONB NOT NULL DEFAULT '{}',
  bleeding_sites  INTEGER DEFAULT 0,
  total_sites     INTEGER DEFAULT 0,
  bleeding_index  NUMERIC(5,2) DEFAULT 0,
  plaque_index    NUMERIC(5,2) DEFAULT 0,
  diagnosis       TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_perio ON dental_periodontal_chart(patient_id, exam_date DESC);
COMMENT ON COLUMN dental_periodontal_chart.measurements IS '{"tooth_11":{"buccal":[depth,depth,depth],"lingual":[d,d,d],"recession":[r,r,r],"mobility":0,"furcation":0,"bleeding":[bool,bool,bool]}, ...}';

-- D-20: Dental waitlist
CREATE TABLE IF NOT EXISTS dental_waitlist (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id      UUID REFERENCES dental_patients(id),
  patient_name    VARCHAR(200) NOT NULL,
  patient_phone   VARCHAR(20),
  procedure_name  VARCHAR(200),
  professional_id UUID,
  preferred_days  JSONB DEFAULT '[]',
  preferred_time  VARCHAR(20),
  urgency         VARCHAR(20) DEFAULT 'normal',
  status          VARCHAR(20) DEFAULT 'aguardando',
  notified_at     TIMESTAMPTZ,
  scheduled_at    TIMESTAMPTZ,
  appointment_id  UUID,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_waitlist ON dental_waitlist(company_id, status);
COMMENT ON COLUMN dental_waitlist.urgency IS 'normal, urgente, prioritario';
COMMENT ON COLUMN dental_waitlist.status IS 'aguardando, notificado, agendado, cancelado';

-- D-21: Patient check-in
CREATE TABLE IF NOT EXISTS dental_checkins (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id      UUID REFERENCES dental_patients(id),
  appointment_id  UUID,
  patient_name    VARCHAR(200),
  method          VARCHAR(20) DEFAULT 'manual',
  checked_in_at   TIMESTAMPTZ DEFAULT NOW(),
  called_at       TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  status          VARCHAR(20) DEFAULT 'arrived'
);

CREATE INDEX IF NOT EXISTS idx_dental_checkins ON dental_checkins(company_id, checked_in_at DESC);
COMMENT ON COLUMN dental_checkins.method IS 'manual, qrcode, whatsapp, app';
COMMENT ON COLUMN dental_checkins.status IS 'arrived, called, in_service, done';

-- Seed basic TUSS codes (most common dental procedures)
INSERT INTO dental_tuss_codes (code, description, specialty, default_price) VALUES
  ('81000030', 'Consulta odontológica inicial', 'geral', 150),
  ('81000049', 'Consulta odontológica de retorno', 'geral', 80),
  ('81000065', 'Consulta odontológica de urgência', 'geral', 200),
  ('82000034', 'Profilaxia (limpeza)', 'geral', 180),
  ('82000107', 'Aplicação de flúor', 'geral', 80),
  ('82000140', 'Aplicação de selante', 'geral', 100),
  ('83000031', 'Restauração resina 1 face', 'geral', 200),
  ('83000040', 'Restauração resina 2 faces', 'geral', 280),
  ('83000058', 'Restauração resina 3 faces', 'geral', 350),
  ('84000038', 'Tratamento endodôntico unirradicular', 'endodontia', 800),
  ('84000046', 'Tratamento endodôntico birradicular', 'endodontia', 1000),
  ('84000054', 'Tratamento endodôntico multirradicular', 'endodontia', 1200),
  ('85000035', 'Raspagem subgengival', 'periodontia', 250),
  ('85000043', 'Raspagem supragengival', 'periodontia', 200),
  ('86000032', 'Exodontia simples', 'cirurgia', 300),
  ('86000040', 'Exodontia de inclusos', 'cirurgia', 600),
  ('87000039', 'Coroa total metalocerâmica', 'protese', 1200),
  ('87000047', 'Coroa total cerâmica pura', 'protese', 1800),
  ('87000055', 'Prótese parcial removível', 'protese', 1500),
  ('87000063', 'Prótese total', 'protese', 2000),
  ('88000036', 'Instalação aparelho ortodôntico fixo', 'ortodontia', 1500),
  ('88000044', 'Manutenção ortodôntica mensal', 'ortodontia', 250),
  ('89000033', 'Implante dentário unitário', 'implante', 3500),
  ('89000041', 'Prótese sobre implante unitária', 'implante', 2500)
ON CONFLICT (code) DO NOTHING;
