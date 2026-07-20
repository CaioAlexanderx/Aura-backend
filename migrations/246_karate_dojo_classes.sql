-- ============================================================
-- AURA DOJÔ — Migration 246: turmas, matrículas e presença (F4)
-- karate_dojo_classes + karate_dojo_class_enrollments +
-- karate_dojo_attendance + karate_dojo_class_settings
-- ------------------------------------------------------------
-- NUMERAÇÃO: 243 (billing F3a), 244 (baas_accounts F3b) e 245 (reminder
-- F3c) já tomados — esta é a 246. Convenção CLAUDE.md: sequencial.
--
-- DECISÃO CENTRAL (F4 Aura Dojô): o dojô organiza os alunos (F2,
-- karate_dojo_students) em TURMAS com grade semanal (weekdays 0=domingo..
-- 6=sábado + horário HH:MM). A matrícula é o vínculo aluno↔turma; a
-- PRESENÇA (uma linha por turma+aluno+data) é o registro que futuramente
-- alimenta os critérios de exame de faixa (F5) — daí o resumo por aluno.
--
-- CHAMADA MANUAL é o caminho PRIMÁRIO; o CHECK-IN POR QR é OPCIONAL, ligado
-- por TOGGLE por dojô (karate_dojo_class_settings.qr_checkin_enabled,
-- default FALSE — nem toda academia exige). O token do QR é STATELESS
-- (HMAC no app, nada persistido aqui).
--
-- weekdays é int[] (0..6). start_time/end_time são TEXT 'HH:MM' (date-pura
-- tz-safe — o app deriva weekday da string, sem fuso). present é NOT NULL
-- (linha só existe quando marcada; "não marcado" = ausência de linha, não
-- present=null). method: 'manual' (chamada) ou 'qr' (check-in).
--
-- Escopo por dojo_id (company vertical karate_dojo). NÃO aplicada em
-- produção neste PR (aplicar via MCP antes do deploy). Idempotente /
-- defensiva (IF NOT EXISTS + constraints em DO $$), padrão das 243/244/245.
-- ============================================================

-- ── Turmas ──
CREATE TABLE IF NOT EXISTS karate_dojo_classes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id     uuid NOT NULL,
  name        text NOT NULL,
  weekdays    integer[] NOT NULL DEFAULT '{}'::integer[],
  start_time  text,
  end_time    text,
  modality    text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_classes
    ADD CONSTRAINT karate_dojo_classes_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_classes_dojo
  ON karate_dojo_classes (dojo_id);

-- ── Matrículas (vínculo aluno↔turma) ──
CREATE TABLE IF NOT EXISTS karate_dojo_class_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id      uuid NOT NULL,
  class_id     uuid NOT NULL,
  student_id   uuid NOT NULL,
  enrolled_at  date NOT NULL DEFAULT CURRENT_DATE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_class_enrollments
    ADD CONSTRAINT karate_dojo_class_enrollments_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_class_enrollments
    ADD CONSTRAINT karate_dojo_class_enrollments_class_id_fkey
    FOREIGN KEY (class_id) REFERENCES karate_dojo_classes(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_class_enrollments
    ADD CONSTRAINT karate_dojo_class_enrollments_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES karate_dojo_students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Uma matrícula por (turma, aluno).
DO $$ BEGIN
  ALTER TABLE karate_dojo_class_enrollments
    ADD CONSTRAINT uq_karate_dojo_class_enrollments_class_student
    UNIQUE (class_id, student_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_class_enrollments_dojo
  ON karate_dojo_class_enrollments (dojo_id);
CREATE INDEX IF NOT EXISTS idx_karate_dojo_class_enrollments_class
  ON karate_dojo_class_enrollments (class_id);
CREATE INDEX IF NOT EXISTS idx_karate_dojo_class_enrollments_student
  ON karate_dojo_class_enrollments (student_id);

-- ── Presença (uma linha por turma+aluno+data) ──
CREATE TABLE IF NOT EXISTS karate_dojo_attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id     uuid NOT NULL,
  class_id    uuid NOT NULL,
  student_id  uuid NOT NULL,
  date        date NOT NULL,
  present     boolean NOT NULL,
  method      text NOT NULL DEFAULT 'manual',
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_attendance
    ADD CONSTRAINT karate_dojo_attendance_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_attendance
    ADD CONSTRAINT karate_dojo_attendance_class_id_fkey
    FOREIGN KEY (class_id) REFERENCES karate_dojo_classes(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_attendance
    ADD CONSTRAINT karate_dojo_attendance_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES karate_dojo_students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_attendance
    ADD CONSTRAINT karate_dojo_attendance_method_check
    CHECK (method IN ('manual', 'qr'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotência do upsert: uma presença por (turma, aluno, data).
DO $$ BEGIN
  ALTER TABLE karate_dojo_attendance
    ADD CONSTRAINT uq_karate_dojo_attendance_class_student_date
    UNIQUE (class_id, student_id, date);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_attendance_dojo
  ON karate_dojo_attendance (dojo_id);
CREATE INDEX IF NOT EXISTS idx_karate_dojo_attendance_student_date
  ON karate_dojo_attendance (student_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_karate_dojo_attendance_class_date
  ON karate_dojo_attendance (class_id, date);

-- ── Toggle do check-in por QR (por dojô) ──
CREATE TABLE IF NOT EXISTS karate_dojo_class_settings (
  dojo_id            uuid PRIMARY KEY,
  qr_checkin_enabled boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_class_settings
    ADD CONSTRAINT karate_dojo_class_settings_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── COMMENTs (modelo) ──
COMMENT ON TABLE karate_dojo_classes IS
  'F4 Aura Dojô: turmas do dojô (grade semanal weekdays 0=domingo..6=sábado + horário HH:MM em texto). Escopo por dojo_id (company karate_dojo).';
COMMENT ON COLUMN karate_dojo_classes.weekdays IS
  'Dias da semana da turma como int[] (0=domingo..6=sábado).';
COMMENT ON TABLE karate_dojo_class_enrollments IS
  'F4 Aura Dojô: matrícula (vínculo aluno↔turma). UNIQUE (class_id, student_id). Remover a matrícula NÃO apaga as presenças já registradas.';
COMMENT ON TABLE karate_dojo_attendance IS
  'F4 Aura Dojô: presença por (turma, aluno, data). present NOT NULL (linha só existe quando marcada; "não marcado" = ausência de linha). method: manual (chamada) ou qr (check-in). Alimenta os critérios de exame de faixa (F5).';
COMMENT ON TABLE karate_dojo_class_settings IS
  'F4 Aura Dojô: configurações de turma por dojô. qr_checkin_enabled é o TOGGLE do check-in por QR (default FALSE — chamada manual é o caminho primário).';
