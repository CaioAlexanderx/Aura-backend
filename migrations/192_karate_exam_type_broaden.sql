-- migration 192: broaden karate_belt_exams.exam_type CHECK
-- A federação cria Exames e Cursos de forma AMPLA (sem especificar o grau).
-- Decisão Caio 25/06/2026: adicionar tipos amplos 'exame' e 'curso'.
-- A constraint antiga aceitava só kyu_regional | dan_estadual | dan_nacional
-- (graus específicos, usados pelos dojôs) e estourava ao criar evento de federação.
--
-- Mantém compat com os valores antigos (não migra dados) e adiciona os amplos.
-- Idempotente: DROP IF EXISTS + recria sempre com o conjunto final.

ALTER TABLE karate_belt_exams
  DROP CONSTRAINT IF EXISTS karate_belt_exams_exam_type_check;

ALTER TABLE karate_belt_exams
  ADD CONSTRAINT karate_belt_exams_exam_type_check
  CHECK (exam_type = ANY (ARRAY[
    'kyu_regional',
    'dan_estadual',
    'dan_nacional',
    'exame',
    'curso'
  ]::text[]));
