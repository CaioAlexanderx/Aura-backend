-- 212_karate_event_canonical.sql
-- Fase 0 (Eventos): fundação do modelo de evento canônico.
-- karate_belt_exams é a tabela ativa de evento (exame + curso + seminário).
-- Já possui description + registration_fields; aqui adicionamos paridade com o
-- schema legado (hours/carga horária) e a lista de ministrantes do evento.
-- Tudo idempotente e aditivo (não-quebrante).

-- 1) Carga horária (paridade com karate_events.hours; critério de promoção)
ALTER TABLE karate_belt_exams ADD COLUMN IF NOT EXISTS hours INTEGER;

-- 2) Ampliar taxonomia de tipo para incluir 'seminario' (curso/exame já aceitos).
--    DROP + ADD idempotente; apenas amplia o conjunto permitido.
ALTER TABLE karate_belt_exams DROP CONSTRAINT IF EXISTS karate_belt_exams_exam_type_check;
ALTER TABLE karate_belt_exams ADD CONSTRAINT karate_belt_exams_exam_type_check
  CHECK (exam_type = ANY (ARRAY[
    'kyu_regional','dan_estadual','dan_nacional','exame','curso','seminario'
  ]));

-- 3) Ministrantes do evento (≠ banca de exame karate_exam_examiners).
--    Nome livre + cargo + imagem de assinatura (usada no certificado na Fase 5).
--    Não exige que o ministrante seja um customer cadastrado.
CREATE TABLE IF NOT EXISTS karate_event_instructors (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID NOT NULL REFERENCES karate_belt_exams(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT,                       -- ex.: "PRESIDENTE FPKT", "Sensei"
  signature_url TEXT,                        -- imagem da assinatura (Fase 5)
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kei_event ON karate_event_instructors(event_id);
ALTER TABLE karate_event_instructors ENABLE ROW LEVEL SECURITY;
