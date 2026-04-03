-- ============================================================
-- AURA. Migration 025b — Dental Clinical Images (D-07)
-- Images linked to patients and optionally to teeth
-- Stored in Cloudflare R2
-- ============================================================

DO $$ BEGIN
  CREATE TYPE dental_image_type AS ENUM ('intraoral','extraoral','radiografia','modelo','outro');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS dental_images (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  patient_id    UUID NOT NULL REFERENCES dental_patients(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES dental_appointments(id) ON DELETE SET NULL,
  tooth_number  INTEGER,
  image_type    dental_image_type DEFAULT 'outro',
  url           TEXT NOT NULL,
  thumbnail_url TEXT,
  file_name     VARCHAR(200),
  file_size     INTEGER,
  description   TEXT,
  taken_at      TIMESTAMPTZ,
  uploaded_by   UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_images_patient ON dental_images(patient_id);
CREATE INDEX IF NOT EXISTS idx_dental_images_company ON dental_images(company_id);
CREATE INDEX IF NOT EXISTS idx_dental_images_tooth ON dental_images(patient_id, tooth_number);
