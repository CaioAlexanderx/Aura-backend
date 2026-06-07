-- ============================================================
-- AURA KARATÊ — Migration 159: Banca examinadora (N membros por exame)
-- APLICADA em 07/06/2026 no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_exam_examiners (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id     UUID NOT NULL REFERENCES karate_belt_exams(id) ON DELETE CASCADE,
  examiner_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role        TEXT,
  dan_level   TEXT,
  confirmed   BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exam_id, examiner_id)
);
CREATE INDEX IF NOT EXISTS idx_karate_exam_examiners_exam ON karate_exam_examiners(exam_id);
ALTER TABLE karate_exam_examiners ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 159
