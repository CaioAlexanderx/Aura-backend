-- ============================================================
-- Migration 010 — Módulo Barbearia/Salão (BE-11)
-- Salão Parceiro (BE-22) já implementado na migration 007
-- ============================================================

CREATE TABLE IF NOT EXISTS barbershop_professionals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT,
  photo_url       TEXT,
  color           TEXT DEFAULT '#6d28d9',
  commission_pct  NUMERIC(5,2) DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100),
  salon_partner_id UUID REFERENCES salon_partners(id) ON DELETE SET NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_barber_professionals_company ON barbershop_professionals(company_id, is_active);

CREATE TABLE IF NOT EXISTS barbershop_services (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  duration_min    SMALLINT NOT NULL DEFAULT 30,
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,
  commission_pct  NUMERIC(5,2),
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_barber_services_company ON barbershop_services(company_id, active);

CREATE TYPE barber_appointment_status AS ENUM (
  'agendado', 'confirmado', 'em_atendimento', 'concluido', 'cancelado', 'faltou'
);

CREATE TABLE IF NOT EXISTS barbershop_appointments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  professional_id UUID NOT NULL REFERENCES barbershop_professionals(id) ON DELETE RESTRICT,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   TEXT,
  customer_phone  TEXT,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_min    SMALLINT NOT NULL DEFAULT 30,
  status          barber_appointment_status NOT NULL DEFAULT 'agendado',
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(12,2) DEFAULT 0,
  deposit_amount  NUMERIC(10,2) DEFAULT 0,
  deposit_paid    BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,
  started_at      TIMESTAMPTZ,
  concluded_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_barber_appt_company  ON barbershop_appointments(company_id, scheduled_at);
CREATE INDEX idx_barber_appt_prof     ON barbershop_appointments(professional_id, scheduled_at);
CREATE INDEX idx_barber_appt_customer ON barbershop_appointments(customer_id);
CREATE INDEX idx_barber_appt_status   ON barbershop_appointments(company_id, status);

CREATE TABLE IF NOT EXISTS barbershop_appointment_services (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id  UUID NOT NULL REFERENCES barbershop_appointments(id) ON DELETE CASCADE,
  service_id      UUID REFERENCES barbershop_services(id) ON DELETE SET NULL,
  service_name    TEXT NOT NULL,
  price           NUMERIC(10,2) NOT NULL,
  commission_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,
  commission_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_barber_appt_services ON barbershop_appointment_services(appointment_id);

CREATE TYPE queue_status AS ENUM ('waiting', 'called', 'in_service', 'done', 'left');

CREATE TABLE IF NOT EXISTS barbershop_queue (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  professional_id UUID REFERENCES barbershop_professionals(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  service_id      UUID REFERENCES barbershop_services(id) ON DELETE SET NULL,
  service_name    TEXT,
  status          queue_status NOT NULL DEFAULT 'waiting',
  position        SMALLINT NOT NULL DEFAULT 0,
  called_at       TIMESTAMPTZ,
  entered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  done_at         TIMESTAMPTZ,
  appointment_id  UUID REFERENCES barbershop_appointments(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_barber_queue_company ON barbershop_queue(company_id, status, position);

CREATE TABLE IF NOT EXISTS barbershop_cut_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  professional_id UUID REFERENCES barbershop_professionals(id) ON DELETE SET NULL,
  appointment_id  UUID REFERENCES barbershop_appointments(id) ON DELETE SET NULL,
  machine_number  TEXT,
  technique       TEXT,
  photo_url       TEXT,
  notes           TEXT,
  preferred_professional BOOLEAN DEFAULT false,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_barber_cut_history_customer ON barbershop_cut_history(customer_id, recorded_at DESC);
CREATE INDEX idx_barber_cut_history_company  ON barbershop_cut_history(company_id, recorded_at DESC);

COMMENT ON TABLE barbershop_professionals IS 'Profissionais do salão. Pode ser vinculado a Salão Parceiro (BE-22).';
COMMENT ON TABLE barbershop_cut_history   IS 'Histórico de corte — máquina, técnica, foto. Diferencial de fidelização.';
COMMENT ON TABLE barbershop_queue         IS 'Fila de espera walk-in. Notificação WhatsApp pendente BE-08.';
