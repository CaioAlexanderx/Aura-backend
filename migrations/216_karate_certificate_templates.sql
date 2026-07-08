-- 216_karate_certificate_templates.sql
-- Fase 3: sistema de templates de certificado + certificados emitidos.
-- Template = layout (A..E) + título + texto (padrão/custom) + selos (PNG).
-- Certificado emitido = snapshot dos dados + template + token de verificação.

CREATE TABLE IF NOT EXISTS karate_certificate_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  layout        TEXT NOT NULL DEFAULT 'A',            -- A..E
  title         TEXT NOT NULL DEFAULT 'CERTIFICADO',
  body_mode     TEXT NOT NULL DEFAULT 'default',      -- 'default' | 'custom'
  body_text     TEXT,                                  -- usado quando custom (tags {nome} etc)
  seals         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{label, image_url}]
  is_default    BOOLEAN NOT NULL DEFAULT false,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kct_fed ON karate_certificate_templates(federation_id);

CREATE TABLE IF NOT EXISTS karate_issued_certificates (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_id          UUID REFERENCES karate_belt_exams(id) ON DELETE SET NULL,
  student_id        UUID REFERENCES customers(id) ON DELETE SET NULL,
  verify_token      TEXT NOT NULL UNIQUE,
  template_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {layout,title,body_mode,body_text,seals}
  data_snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {participant_name,course_name,hours,instructors_text,dates_text,location,issued_date_text,federation_name,signatories}
  revoked           BOOLEAN NOT NULL DEFAULT false,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kic_event ON karate_issued_certificates(event_id);
CREATE INDEX IF NOT EXISTS idx_kic_fed ON karate_issued_certificates(federation_id);

ALTER TABLE karate_certificate_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE karate_issued_certificates ENABLE ROW LEVEL SECURITY;
