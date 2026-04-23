-- ============================================================
-- AURA. — Migration 050: Unify Customers & Patients (D-UNIFY)
--
-- Estrategia: customers vira base unica de pessoa.
-- Modulo odonto passa a usar customers com is_patient=true.
-- Campos clinicos vao como colunas nullable em customers.
-- LGPD consent obrigatorio para is_patient=true (enforced em app).
--
-- dental_patients permanece como tabela durante a transicao.
-- Backfill: scripts/backfill-patients-to-customers.js
--
-- Ordem de execucao:
--   1. Aplicar esta migration (Supabase dashboard)
--   2. Rodar script de backfill (node scripts/backfill-patients-to-customers.js)
--   3. Deploy rotas atualizadas (proxima PR)
--   4. Em migration futura: DROP dental_patients
-- ============================================================

-- ── 1. Campos clinicos + identidade em customers ──────────

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS is_patient      BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gender          TEXT,
  ADD COLUMN IF NOT EXISTS allergies       TEXT,
  ADD COLUMN IF NOT EXISTS medical_history TEXT,
  ADD COLUMN IF NOT EXISTS medications     TEXT,
  ADD COLUMN IF NOT EXISTS insurance_name  TEXT,
  ADD COLUMN IF NOT EXISTS insurance_card  TEXT,
  ADD COLUMN IF NOT EXISTS insurance_plan  TEXT,
  ADD COLUMN IF NOT EXISTS insurance_exp   DATE,
  ADD COLUMN IF NOT EXISTS lgpd_consent    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS lgpd_consent_at TIMESTAMPTZ;

-- Check constraint para gender (separado pra ser idempotente)
DO $$ BEGIN
  ALTER TABLE customers
    ADD CONSTRAINT customers_gender_check
    CHECK (gender IN ('M','F','outro') OR gender IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Indice parcial: listagem rapida de pacientes
CREATE INDEX IF NOT EXISTS idx_customers_patient
  ON customers(company_id, is_patient)
  WHERE is_patient = true;

-- ── 2. customer_id nas tabelas dental_* ──────────────────
-- RESTRICT em appointments/prescriptions (registros legais/clinicos)
-- CASCADE em chart/plans (metadados derivados)

ALTER TABLE dental_appointments
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE dental_chart_entries
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE dental_prescriptions
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE dental_treatment_plans
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_dental_appts_customer ON dental_appointments(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_chart_customer ON dental_chart_entries(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_presc_customer ON dental_prescriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_plans_customer ON dental_treatment_plans(customer_id);

-- ── 3. Tornar patient_id nullable durante transicao ───────
-- patient_id era NOT NULL — agora opcional para permitir INSERT
-- novos usando somente customer_id. Backfill preenche os existentes.

ALTER TABLE dental_appointments    ALTER COLUMN patient_id DROP NOT NULL;
ALTER TABLE dental_prescriptions   ALTER COLUMN patient_id DROP NOT NULL;
ALTER TABLE dental_treatment_plans ALTER COLUMN patient_id DROP NOT NULL;
ALTER TABLE dental_chart_entries   ALTER COLUMN patient_id DROP NOT NULL;

-- ── 4. Documentacao ──────────────────────────────────────

COMMENT ON COLUMN customers.is_patient IS
  'true quando o cliente tambem e paciente odonto. Requer lgpd_consent=true.';

COMMENT ON COLUMN customers.lgpd_consent IS
  'Consentimento LGPD Art.11 para dados de saude. Obrigatorio para is_patient=true.';

COMMENT ON COLUMN dental_appointments.customer_id IS
  'Fonte de verdade apos migration 050. patient_id mantido temporariamente para backfill.';

COMMENT ON COLUMN dental_chart_entries.customer_id IS
  'Fonte de verdade apos migration 050. patient_id mantido temporariamente para backfill.';

COMMENT ON COLUMN dental_prescriptions.customer_id IS
  'Fonte de verdade apos migration 050. patient_id mantido temporariamente para backfill.';

COMMENT ON COLUMN dental_treatment_plans.customer_id IS
  'Fonte de verdade apos migration 050. patient_id mantido temporariamente para backfill.';
