-- 203_karate_exam_description.sql
-- Descrição/regras do evento (exame/curso). Exibida na visão interna e no
-- portal público (página do evento). Nullable; sem default.
ALTER TABLE karate_belt_exams ADD COLUMN IF NOT EXISTS description TEXT;
