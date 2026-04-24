-- ============================================================
-- AURA. — Migration 047: Backfill dental para o D-UNIFY
--
-- CONTEXTO: varias migrations foram aplicadas em producao via MCP
-- Supabase entre 15 e 22/04 sem serem commitadas como arquivo .sql
-- no repositorio. Isso quebra o CI do GitHub Actions que roda
-- migrations num banco limpo — a 051_unify_dental_remaining_tables
-- tenta ALTER TABLE dental_portal_tokens (entre outras) e falha
-- porque a tabela nao existe ainda.
--
-- Esta migration e totalmente IDEMPOTENTE (CREATE TABLE IF NOT EXISTS
-- + ALTER TABLE IF NOT EXISTS) — em producao e no-op, no CI cria o
-- schema necessario pra 050/051/052/053 passarem.
--
-- Equivalente no prod: migrations MCP
--   20260418044832 dental_funnel_billing_repasse
--   20260418141114 dental_portal_and_automation
--   20260418154224 add_practitioner_id_to_dental_appointments
--   20260423125714 049_dental_practitioners_and_settings
-- ============================================================

-- ── 1. dental_practitioners (base pra repasses + FK) ──────────────
CREATE TABLE IF NOT EXISTS dental_practitioners (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  cro         text,
  specialty   text,
  color       text        DEFAULT '#06B6D4',
  email       text,
  phone       text,
  is_active   boolean     NOT NULL DEFAULT true,
  is_owner    boolean     NOT NULL DEFAULT false,
  repasse_pct numeric(5,2) NOT NULL DEFAULT 50.00 CHECK (repasse_pct >= 0 AND repasse_pct <= 100),
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  updated_at  timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dental_practitioners_company ON dental_practitioners(company_id);

-- dental_appointments.practitioner_id (coluna pra alocacao de cadeira)
ALTER TABLE dental_appointments
  ADD COLUMN IF NOT EXISTS practitioner_id uuid;
CREATE INDEX IF NOT EXISTS idx_dental_appointments_practitioner
  ON dental_appointments(practitioner_id);

-- companies.dental_settings (cadeiras + horarios)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS dental_settings jsonb
  DEFAULT '{"chairs_count":1,"chairs_active":[true],"chair_practitioner_ids":[null],"schedule_blocks":[]}'::jsonb;

-- ── 2. dental_leads + historico (ODT-1 funil CRM) ─────────────────
CREATE TABLE IF NOT EXISTS dental_leads (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id        uuid,
  stage             varchar(40)  NOT NULL DEFAULT 'lead',
  source            varchar(40)  DEFAULT 'walkin',
  lead_name         varchar(200) NOT NULL,
  lead_phone        varchar(40),
  lead_email        varchar(200),
  treatment_value   numeric      DEFAULT 0,
  treatment_plan_id uuid,
  notes             text,
  assigned_to       uuid,
  lost_reason       text,
  stage_changed_at  timestamptz  DEFAULT NOW(),
  created_at        timestamptz  DEFAULT NOW(),
  updated_at        timestamptz  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dental_leads_company ON dental_leads(company_id);
CREATE INDEX IF NOT EXISTS idx_dental_leads_stage   ON dental_leads(company_id, stage);

CREATE TABLE IF NOT EXISTS dental_lead_history (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    uuid        NOT NULL REFERENCES dental_leads(id) ON DELETE CASCADE,
  from_stage varchar(40),
  to_stage   varchar(40) NOT NULL,
  changed_by uuid,
  notes      text,
  created_at timestamptz DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dental_lead_history_lead ON dental_lead_history(lead_id);

-- ── 3. dental_billing_reminders (ODT-1 regua cobranca) ────────────
CREATE TABLE IF NOT EXISTS dental_billing_reminders (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id        uuid,
  payment_id        uuid,
  treatment_plan_id uuid,
  reminder_type     varchar(40) NOT NULL,
  channel           varchar(20) DEFAULT 'whatsapp',
  sent_at           timestamptz DEFAULT NOW(),
  amount            numeric,
  due_date          date,
  response          varchar(40)
);
CREATE INDEX IF NOT EXISTS idx_dental_billing_reminders_company
  ON dental_billing_reminders(company_id);

-- ── 4. dental_repasse_ledger (ODT-2 repasse dentista) ─────────────
CREATE TABLE IF NOT EXISTS dental_repasse_ledger (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  practitioner_id   uuid        NOT NULL,
  treatment_plan_id uuid,
  procedure_name    varchar(200),
  amount            numeric     NOT NULL DEFAULT 0,
  repasse_pct       numeric     NOT NULL DEFAULT 50,
  repasse_amount    numeric     NOT NULL DEFAULT 0,
  reference_month   varchar(7)  NOT NULL,
  status            varchar(20) DEFAULT 'pending',
  paid_at           timestamptz,
  created_at        timestamptz DEFAULT NOW(),
  updated_at        timestamptz DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dental_repasse_ledger_company
  ON dental_repasse_ledger(company_id);

-- ── 5. dental_portal_tokens (ODT-3 portal paciente) ───────────────
CREATE TABLE IF NOT EXISTS dental_portal_tokens (
  id         uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id uuid,
  token      varchar(100) NOT NULL UNIQUE,
  expires_at timestamptz  NOT NULL,
  created_at timestamptz  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dental_portal_tokens_company
  ON dental_portal_tokens(company_id);
CREATE INDEX IF NOT EXISTS idx_dental_portal_tokens_token
  ON dental_portal_tokens(token);

-- ── 6. dental_ws_tokens (assinatura digital via link) ─────────────
CREATE TABLE IF NOT EXISTS dental_ws_tokens (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  appointment_id uuid        NOT NULL,
  token          text        NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  signature_url  text,
  created_at     timestamptz NOT NULL DEFAULT NOW()
);

-- ── 7. dental_automation_config + log (ODT-4 automacoes) ──────────
CREATE TABLE IF NOT EXISTS dental_automation_config (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid        NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  confirm_enabled          boolean     DEFAULT true,
  confirm_hours_before     int         DEFAULT 24,
  remind_enabled           boolean     DEFAULT true,
  remind_hours_before      int         DEFAULT 2,
  recall_enabled           boolean     DEFAULT true,
  recall_days              int         DEFAULT 180,
  satisfaction_enabled     boolean     DEFAULT true,
  satisfaction_hours_after int         DEFAULT 24,
  updated_at               timestamptz DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dental_automation_log (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id     uuid,
  appointment_id uuid,
  type           varchar(40) NOT NULL,
  channel        varchar(20) DEFAULT 'whatsapp',
  message        text,
  status         varchar(20) DEFAULT 'sent',
  response       text,
  sent_at        timestamptz DEFAULT NOW(),
  responded_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dental_automation_log_company
  ON dental_automation_log(company_id);
CREATE INDEX IF NOT EXISTS idx_dental_automation_log_appointment
  ON dental_automation_log(appointment_id);

-- ── 8. dental_booking_config + requests (agenda online) ───────────
CREATE TABLE IF NOT EXISTS dental_booking_config (
  id                uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid         NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  is_active         boolean      DEFAULT false,
  slug              varchar(100),
  welcome_msg       text         DEFAULT 'Agende sua consulta online',
  min_advance_hours int          DEFAULT 2,
  max_advance_days  int          DEFAULT 30,
  slot_duration_min int          DEFAULT 60,
  available_days    jsonb        DEFAULT '[1,2,3,4,5]'::jsonb,
  start_hour        int          DEFAULT 8,
  end_hour          int          DEFAULT 18,
  require_phone     boolean      DEFAULT true,
  created_at        timestamptz  DEFAULT NOW(),
  updated_at        timestamptz  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dental_booking_requests (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_name     varchar(200) NOT NULL,
  patient_phone    varchar(40),
  patient_email    varchar(200),
  preferred_date   date         NOT NULL,
  preferred_time   time         NOT NULL,
  chief_complaint  text,
  status           varchar(30)  DEFAULT 'pendente',
  appointment_id   uuid,
  notes            text,
  created_at       timestamptz  DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dental_booking_requests_company
  ON dental_booking_requests(company_id);
