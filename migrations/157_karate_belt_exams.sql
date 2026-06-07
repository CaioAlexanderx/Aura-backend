-- ============================================================
-- AURA KARATÊ — Migration 157: Exames de graduação
-- karate_belt_exams + karate_belt_exam_candidates.
-- Também adiciona a FK de karate_belt_history.exam_id (resolve V5).
-- APLICADA em 07/06/2026 no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_belt_exams (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  exam_type      TEXT NOT NULL CHECK (exam_type IN ('kyu_regional','dan_estadual','dan_nacional')),
  name           TEXT,
  event_date     DATE NOT NULL,
  location       TEXT,
  max_candidates INT,
  fee_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','done')),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_karate_exams_federation ON karate_belt_exams(federation_id, event_date DESC);

CREATE TABLE IF NOT EXISTS karate_belt_exam_candidates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id          UUID NOT NULL REFERENCES karate_belt_exams(id) ON DELETE CASCADE,
  student_id       UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  current_belt     TEXT,
  target_belt      TEXT NOT NULL,
  target_belt_name TEXT,
  belt_schema      TEXT NOT NULL DEFAULT 'fpkt_shotokan' CHECK (belt_schema IN ('legacy','fpkt_shotokan')),
  status           TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','confirmed','checked_in','approved','rejected','absent')),
  result_notes     TEXT,
  fee_paid         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exam_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_karate_exam_candidates_exam ON karate_belt_exam_candidates(exam_id, status);
CREATE INDEX IF NOT EXISTS idx_karate_exam_candidates_student ON karate_belt_exam_candidates(student_id);

-- FK de karate_belt_history.exam_id agora que os exames existem (resolve V5)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_belt_history_exam') THEN
    ALTER TABLE karate_belt_history
      ADD CONSTRAINT fk_belt_history_exam FOREIGN KEY (exam_id)
      REFERENCES karate_belt_exams(id) ON DELETE SET NULL;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_karate_exams_updated_at ON karate_belt_exams;
CREATE TRIGGER trg_karate_exams_updated_at BEFORE UPDATE ON karate_belt_exams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_karate_exam_candidates_updated_at ON karate_belt_exam_candidates;
CREATE TRIGGER trg_karate_exam_candidates_updated_at BEFORE UPDATE ON karate_belt_exam_candidates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_belt_exams ENABLE ROW LEVEL SECURITY;
ALTER TABLE karate_belt_exam_candidates ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 157
