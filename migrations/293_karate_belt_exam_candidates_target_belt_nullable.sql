-- ============================================================
-- AURA KARATÊ — Migration 293: target_belt do candidato passa a ser NULLABLE
-- ------------------------------------------------------------
-- Bug (P0): karate_belt_exam_candidates.target_belt nasceu NOT NULL na
-- migration 157, mas a decisão de produto (08/06/2026, mesma do caminho
-- público e da submissão do dojô) é que a BANCA define a faixa DEPOIS — o
-- dojô/portal submete a PESSOA, não a graduação. Os três caminhos de
-- inscrição (karateEventEnrollmentService, karatePublic, submissão do dojô)
-- omitem target_belt no INSERT, então TODA inscrição estourava 23502
-- (not_null_violation) e virava 500. O comentário no código já afirmava
-- "A coluna é nullable em produção" — esta migration torna isso verdade.
--
-- A faixa alcançada passa a ser gravada no LANÇAMENTO do resultado
-- (PATCH /belt-exams/:examId/candidates/:candidateId), que agora exige
-- target_belt para aprovar (senão o trigger karate_on_exam_approved
-- inseriria NULL em karate_belt_history.belt_level, também NOT NULL).
--
-- Idempotente: DROP NOT NULL não falha se a coluna já for nullable.
-- ============================================================

ALTER TABLE karate_belt_exam_candidates
  ALTER COLUMN target_belt DROP NOT NULL;

-- ============================================================
-- FIM DA MIGRATION 293
-- ============================================================
