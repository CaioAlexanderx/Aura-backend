-- ============================================================
-- AURA. Migration 027 — Dental Tier 2: Recall + No-show + Booking
-- D-09: Recall fields on patients
-- D-10: No-show tracking
-- D-11: Public booking config
-- ============================================================

-- D-09: Recall control
ALTER TABLE dental_patients ADD COLUMN IF NOT EXISTS next_recall DATE;
ALTER TABLE dental_patients ADD COLUMN IF NOT EXISTS recall_interval_months INTEGER DEFAULT 6;
ALTER TABLE dental_patients ADD COLUMN IF NOT EXISTS last_recall_sent TIMESTAMPTZ;

-- D-10: No-show tracking
ALTER TABLE dental_patients ADD COLUMN IF NOT EXISTS no_show_count INTEGER DEFAULT 0;
ALTER TABLE dental_patients ADD COLUMN IF NOT EXISTS last_no_show TIMESTAMPTZ;

-- D-11: Public booking configuration
CREATE TABLE IF NOT EXISTS dental_booking_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  is_active     BOOLEAN DEFAULT false,
  slug          VARCHAR(50) UNIQUE,
  welcome_msg   TEXT DEFAULT 'Agende sua consulta online',
  min_advance_hours INTEGER DEFAULT 2,
  max_advance_days  INTEGER DEFAULT 30,
  slot_duration_min INTEGER DEFAULT 60,
  available_days    JSONB DEFAULT '[1,2,3,4,5]'::jsonb,
  start_hour    INTEGER DEFAULT 8,
  end_hour      INTEGER DEFAULT 18,
  require_phone BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_booking_slug ON dental_booking_config(slug);

-- D-11: Public booking requests (unauth)
CREATE TABLE IF NOT EXISTS dental_booking_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_name  VARCHAR(200) NOT NULL,
  patient_phone VARCHAR(20),
  patient_email VARCHAR(200),
  preferred_date DATE NOT NULL,
  preferred_time TIME NOT NULL,
  chief_complaint TEXT,
  status        VARCHAR(20) DEFAULT 'pendente',
  appointment_id UUID REFERENCES dental_appointments(id),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_booking_reqs ON dental_booking_requests(company_id, status);
