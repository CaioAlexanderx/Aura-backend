-- ============================================================
-- Migration 008 — Módulo Odontologia (BE-25)
-- Grupos 1, 2 e 3 MVP + preparativos BE-25-10 (WebSocket)
-- ============================================================

-- ── Ficha clínica do paciente (separada de customers) ─────

CREATE TABLE IF NOT EXISTS dental_patients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  full_name       TEXT NOT NULL,
  birth_date      DATE,
  cpf             TEXT,
  phone           TEXT,
  email           TEXT,
  gender          TEXT CHECK (gender IN ('M', 'F', 'outro', NULL)),
  allergies       TEXT,
  medical_history TEXT,
  medications     TEXT,
  notes           TEXT,
  insurance_name  TEXT,
  insurance_card  TEXT,
  insurance_plan  TEXT,
  insurance_exp   DATE,
  lgpd_consent    BOOLEAN NOT NULL DEFAULT false,
  lgpd_consent_at TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dental_patients_company ON dental_patients(company_id, is_active);
CREATE INDEX idx_dental_patients_name    ON dental_patients(company_id, full_name);

-- ── Catálogo de procedimentos ─────────────────────────────

CREATE TYPE dental_category AS ENUM (
  'diagnostico', 'prevencao', 'dentistica', 'endodontia',
  'cirurgia', 'protese', 'ortodontia', 'outros'
);

CREATE TABLE IF NOT EXISTS dental_procedures (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code_internal   TEXT NOT NULL,
  code_tuss       TEXT,
  category        dental_category NOT NULL DEFAULT 'outros',
  name            TEXT NOT NULL,
  description     TEXT,
  price_private   NUMERIC(10,2) NOT NULL DEFAULT 0,
  price_plan      NUMERIC(10,2),
  requires_auth   BOOLEAN NOT NULL DEFAULT false,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code_internal)
);

CREATE INDEX idx_dental_procedures_company ON dental_procedures(company_id, active);

-- ── Agenda / Atendimentos ─────────────────────────────────

CREATE TYPE dental_appointment_status AS ENUM (
  'agendado', 'avaliacao', 'aprovado', 'em_atendimento',
  'concluido', 'cancelado', 'faltou'
);

CREATE TABLE IF NOT EXISTS dental_appointments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES dental_patients(id) ON DELETE RESTRICT,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_min    SMALLINT NOT NULL DEFAULT 60,
  status          dental_appointment_status NOT NULL DEFAULT 'agendado',
  chief_complaint TEXT,
  anamnesis       TEXT,
  clinical_notes  TEXT,
  subtotal        NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_type   TEXT CHECK (discount_type IN ('percent', 'fixed', NULL)),
  discount_value  NUMERIC(10,2),
  total           NUMERIC(12,2) NOT NULL DEFAULT 0,
  consent_signed  BOOLEAN NOT NULL DEFAULT false,
  consent_sig_url TEXT,
  consent_at      TIMESTAMPTZ,
  conclusion_sig_url  TEXT,
  conclusion_signed   BOOLEAN NOT NULL DEFAULT false,
  conclusion_at       TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  concluded_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dental_appt_company ON dental_appointments(company_id, scheduled_at);
CREATE INDEX idx_dental_appt_patient ON dental_appointments(patient_id, status);
CREATE INDEX idx_dental_appt_status  ON dental_appointments(company_id, status);

-- ── Procedimentos do atendimento ─────────────────────────

CREATE TABLE IF NOT EXISTS dental_appointment_procedures (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id  UUID NOT NULL REFERENCES dental_appointments(id) ON DELETE CASCADE,
  procedure_id    UUID REFERENCES dental_procedures(id) ON DELETE SET NULL,
  procedure_name  TEXT NOT NULL,
  code_tuss       TEXT,
  category        dental_category,
  quantity        SMALLINT NOT NULL DEFAULT 1,
  price_unit      NUMERIC(10,2) NOT NULL,
  price_total     NUMERIC(12,2) NOT NULL,
  tooth_number    SMALLINT,
  tooth_face      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dental_appt_procs ON dental_appointment_procedures(appointment_id);

-- ── Odontograma (BE-25-09) ────────────────────────────────

CREATE TYPE dental_face AS ENUM ('mesial', 'distal', 'oclusal', 'vestibular', 'lingual');
CREATE TYPE dental_tooth_status AS ENUM (
  'saudavel', 'carie', 'restaurado', 'ausente',
  'coroa', 'implante', 'fraturado', 'outros'
);

CREATE TABLE IF NOT EXISTS dental_chart_entries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES dental_patients(id) ON DELETE CASCADE,
  appointment_id  UUID REFERENCES dental_appointments(id) ON DELETE SET NULL,
  tooth_number    SMALLINT NOT NULL,
  face            dental_face,
  status          dental_tooth_status NOT NULL DEFAULT 'saudavel',
  procedure_id    UUID REFERENCES dental_procedures(id) ON DELETE SET NULL,
  notes           TEXT,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dental_chart_patient ON dental_chart_entries(patient_id, tooth_number);
CREATE INDEX idx_dental_chart_company ON dental_chart_entries(company_id, recorded_at);

-- ── Receituário e atestados (BE-25-05) ────────────────────

CREATE TYPE dental_document_type AS ENUM ('receituario', 'atestado', 'declaracao', 'outros');

CREATE TABLE IF NOT EXISTS dental_prescriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES dental_patients(id) ON DELETE RESTRICT,
  appointment_id  UUID REFERENCES dental_appointments(id) ON DELETE SET NULL,
  doc_type        dental_document_type NOT NULL DEFAULT 'receituario',
  content         TEXT NOT NULL,
  pdf_url         TEXT,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dental_prescriptions_patient ON dental_prescriptions(patient_id, issued_at);

-- ── Tokens WebSocket para assinatura remota (BE-25-10 prep) ──

CREATE TABLE IF NOT EXISTS dental_ws_tokens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  appointment_id  UUID NOT NULL REFERENCES dental_appointments(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  signature_url   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dental_ws_tokens_token ON dental_ws_tokens(token, expires_at);

COMMENT ON TABLE dental_patients IS 'Ficha clínica separada de customers — LGPD Art.11.';
COMMENT ON COLUMN dental_procedures.code_tuss IS 'Código TUSS interno — dentista não vê. Usado na GTO (Grupo 4 V1.1).';
COMMENT ON TABLE dental_ws_tokens IS 'Tokens temporários para assinatura via QR+WebSocket (BE-25-10). Expira em 10 min.';
