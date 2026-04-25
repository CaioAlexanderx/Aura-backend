-- ============================================================
-- AURA. — W3 Sprint 2: ORTODONTIA A2
--
-- Aplicada em producao via MCP Supabase em 25/04/2026.
-- Arquivo espelho criado conforme regra de migration da sessao
-- (toda apply_migration via MCP DEVE ter .sql no repo pra CI).
--
-- Fluxo clinico (18-24 meses tipico):
--   1. Avaliacao + moldagem + Rx
--   2. Instalacao do aparelho
--   3. Consultas mensais de ajuste (~18-24 sessoes)
--   4. Remocao do aparelho
--   5. Fase de retencao (retentores)
--
-- 2 tabelas:
--   dental_ortho_treatments  - tratamento ortodontico do paciente
--   dental_ortho_sessions    - consultas/sessoes individuais
-- ============================================================

-- ── dental_ortho_treatments ─────────────────────────────────
CREATE TABLE IF NOT EXISTS dental_ortho_treatments (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id             uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  practitioner_id         uuid        REFERENCES dental_practitioners(id) ON DELETE SET NULL,
  treatment_number        varchar(25) NOT NULL,
  appliance_type          varchar(40) NOT NULL DEFAULT 'brackets_metal',
  arch                    varchar(10) NOT NULL DEFAULT 'both',
  status                  varchar(20) NOT NULL DEFAULT 'planning',
  start_date              date,
  expected_end_date       date,
  estimated_duration_months smallint  NOT NULL DEFAULT 18,
  total_sessions_planned  smallint    NOT NULL DEFAULT 18,
  total_value             numeric(12,2),
  chief_complaint         text,
  diagnosis               text,
  treatment_plan_id       uuid,
  completed_at            timestamptz,
  abandoned_at            timestamptz,
  abandon_reason          text,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT NOW(),
  updated_at              timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, treatment_number)
);

CREATE INDEX IF NOT EXISTS idx_ortho_treatments_customer
  ON dental_ortho_treatments(company_id, customer_id, status);
CREATE INDEX IF NOT EXISTS idx_ortho_treatments_status
  ON dental_ortho_treatments(company_id, status, start_date DESC);

-- ── dental_ortho_sessions ───────────────────────────────────
CREATE TABLE IF NOT EXISTS dental_ortho_sessions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  treatment_id     uuid        NOT NULL REFERENCES dental_ortho_treatments(id) ON DELETE CASCADE,
  company_id       uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id      uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  session_number   smallint    NOT NULL,
  session_type     varchar(30) NOT NULL DEFAULT 'adjustment',
  appointment_id   uuid        REFERENCES dental_appointments(id) ON DELETE SET NULL,
  planned_date     date,
  completed_date   timestamptz,
  wire_upper       varchar(40),
  wire_lower       varchar(40),
  procedures       text,
  evolution        text,
  next_interval_weeks smallint DEFAULT 4,
  status           varchar(20) NOT NULL DEFAULT 'planned',
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT NOW(),
  updated_at       timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (treatment_id, session_number)
);

CREATE INDEX IF NOT EXISTS idx_ortho_sessions_treatment
  ON dental_ortho_sessions(treatment_id, session_number);
CREATE INDEX IF NOT EXISTS idx_ortho_sessions_status
  ON dental_ortho_sessions(company_id, status, planned_date)
  WHERE status IN ('planned', 'in_progress');

-- ── Triggers updated_at ──────────────────────────────────────
CREATE OR REPLACE FUNCTION update_ortho_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ortho_treatments_updated_at ON dental_ortho_treatments;
CREATE TRIGGER trg_ortho_treatments_updated_at
  BEFORE UPDATE ON dental_ortho_treatments
  FOR EACH ROW EXECUTE FUNCTION update_ortho_updated_at();

DROP TRIGGER IF EXISTS trg_ortho_sessions_updated_at ON dental_ortho_sessions;
CREATE TRIGGER trg_ortho_sessions_updated_at
  BEFORE UPDATE ON dental_ortho_sessions
  FOR EACH ROW EXECUTE FUNCTION update_ortho_updated_at();

-- ── Funcao numeracao sequencial ──────────────────────────────
CREATE OR REPLACE FUNCTION ortho_treatment_next_number(p_company_id uuid)
RETURNS varchar AS $$
DECLARE
  v_seq int;
  v_today varchar;
BEGIN
  v_today := to_char(CURRENT_DATE, 'YYYYMMDD');
  SELECT COALESCE(COUNT(*), 0) + 1 INTO v_seq
    FROM dental_ortho_treatments
   WHERE company_id = p_company_id
     AND treatment_number LIKE 'ORT-' || v_today || '-%';
  RETURN 'ORT-' || v_today || '-' || lpad(v_seq::text, 3, '0');
END;
$$ LANGUAGE plpgsql;
