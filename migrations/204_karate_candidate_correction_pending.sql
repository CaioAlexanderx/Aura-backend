-- 204_karate_candidate_correction_pending.sql
-- A rota de correção de resultado insere status='correction_pending' em
-- karate_belt_exam_candidates, mas o CHECK (migration 157) não o permitia → 500.
-- Adiciona 'correction_pending' ao conjunto permitido (idempotente).
ALTER TABLE karate_belt_exam_candidates
  DROP CONSTRAINT IF EXISTS karate_belt_exam_candidates_status_check;
ALTER TABLE karate_belt_exam_candidates
  ADD CONSTRAINT karate_belt_exam_candidates_status_check
  CHECK (status IN ('registered','confirmed','checked_in','approved','rejected','absent','correction_pending'));
