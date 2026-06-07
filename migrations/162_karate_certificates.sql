-- ============================================================
-- AURA KARATÊ — Migration 162: Certificados (sob demanda)
-- Usada por karateCertificateService.issueCertificate.
-- APLICADA em 07/06/2026 no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_certificates (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  exam_id         UUID REFERENCES karate_belt_exams(id) ON DELETE SET NULL,
  candidate_id    UUID REFERENCES karate_belt_exam_candidates(id) ON DELETE SET NULL,
  student_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  target_belt     TEXT,
  certificate_url TEXT,
  r2_key          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','generated','sent','error')),
  issued_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  issued_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_karate_certificates_candidate ON karate_certificates(candidate_id);
CREATE INDEX IF NOT EXISTS idx_karate_certificates_student ON karate_certificates(student_id);
CREATE INDEX IF NOT EXISTS idx_karate_certificates_federation ON karate_certificates(federation_id);

DROP TRIGGER IF EXISTS trg_karate_certificates_updated_at ON karate_certificates;
CREATE TRIGGER trg_karate_certificates_updated_at BEFORE UPDATE ON karate_certificates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_certificates ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 162
