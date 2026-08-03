-- ============================================================
-- AURA DOJÔ — Migration 268: F9, EVENTOS DO DOJÔ (curso + seminário)
--
-- Pedido do dono do produto (03/08/2026):
--   "Precisamos ter a opção também de criar evento, para criar exames de
--    faixa (Kyu), cursos, seminários, etc. Podemos usar a estrutura
--    idêntica de criação de eventos que já temos na federação."
--
-- ESCOPO DESTA FASE: curso e seminário. Campeonato do dojô virou fase
-- separada (subsistema completo: categorias, chaveamento, kata) e NÃO
-- entra aqui — mas o modelo abaixo é desenhado para não impedir isso.
--
-- ============================================================
-- (0) POR QUE O EXAME DE KYU NÃO ENTRA NUMA TABELA GENÉRICA
-- ============================================================
-- O exame de kyu JÁ EXISTE, pronto, com regra de negócio que nada mais
-- tem: karate_dojo_belt_exams + karate_dojo_belt_exam_results (migrations
-- 264/265), serviço karateDojoBeltExamService.js, rotas
-- /federation/:id/dojo/graduation-exams. Ele carrega:
--   • faixa de origem/destino com kyu/dan e o TETO DO SENSEI (CHECK que
--     proíbe faixa preta — banca é exclusiva da federação);
--   • ligação idempotente com karate_belt_history (source='exam_dojo');
--   • cascata de pedido de certificado por aluno.
-- Nada disso existe para curso/seminário. Forçar os três num modelo
-- comum obrigaria o curso a herdar colunas de graduação que não usa, ou o
-- exame a abrir mão de regras que já são contrato de produto. Por isso
-- este PR cria um modelo PRÓPRIO para curso/seminário e faz a
-- LISTAGEM (não o dado) enxergar as duas fontes juntas — a UNION mora no
-- código (karateDojoEventService.listEventsHub), não no banco.
--
-- ============================================================
-- (1) NÃO É karate_events / karateCourses.js
-- ============================================================
-- karate_events (migration 160) é o modelo de CURSO LEGADO da federação —
-- completo, mas órfão de UI (karateCourses.js nunca ganhou tela). Decisão
-- explícita do dono: NÃO ressuscitar esse caminho. O evento do DOJÔ é um
-- modelo novo, escopado por dojo_id — o dojô cria o próprio curso/
-- seminário, sem depender de a federação ter cadastrado nada.
--
-- ============================================================
-- (2) AS DUAS TABELAS
-- ============================================================
-- karate_dojo_events            — o evento (curso | seminário) do dojô.
--   Espelha os campos ÚTEIS de karate_belt_exams (nome, tipo, data, local,
--   taxa, vagas, carga horária, descrição, status) — é a "estrutura
--   idêntica de criação de eventos" que o dono pediu, sem herdar o que
--   não se aplica (registration_fields, max_candidates com significado
--   de banca, etc).
--
-- karate_dojo_event_enrollments — inscrição do ALUNO DO DOJÔ no evento.
--   Ancorada em karate_dojo_students (NÃO em customers): é o mesmo motivo
--   da 264 para karate_dojo_belt_exam_results — o aluno NÃO FEDERADO
--   também participa de curso/seminário do próprio dojô. practitioner_id
--   é um SNAPSHOT do vínculo federativo no momento da inscrição (nullable).
--
-- ── PREPARADO PARA O CAMPEONATO ENTRAR DEPOIS, SEM QUEBRAR NADA ──
-- kind hoje só aceita 'curso' e 'seminario' — o CHECK é estreito de
-- propósito (mesma mecânica da migration 265 para
-- karate_documents.owner_type: ampliar um CHECK exige recriá-lo, então
-- widening é uma migration futura de 3 linhas, não uma reforma de schema).
-- Quando o campeonato do dojô ganhar sua fase, ele PODE tanto (a) ganhar
-- 'campeonato' neste mesmo kind se as colunas bastarem, quanto (b) viver
-- em tabela própria (mais provável, dado que chaveamento/categoria/kata
-- não cabem aqui) e aparecer na listagem unificada como uma TERCEIRA
-- fonte — o formato de saída já usa um discriminador `source` justamente
-- para isso (ver karateDojoEventService.listEventsHub).
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- O dojô dono do evento (companies.id, vertical karate_dojo).
  dojo_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Federação a que o dojô é filiado no momento da criação. NULLABLE:
  -- dojô sem filiação também cria os próprios cursos/seminários — mesma
  -- decisão da 264 para karate_dojo_belt_exams.federation_id.
  federation_id  UUID REFERENCES companies(id) ON DELETE SET NULL,

  -- Discriminador. CHECK estreito de propósito — ver nota (2) acima.
  kind           TEXT NOT NULL,

  name           TEXT NOT NULL,
  event_date     DATE NOT NULL,
  location       TEXT,

  fee_amount        NUMERIC(10,2),
  max_participants  INTEGER,
  hours             NUMERIC(5,1),
  description       TEXT,

  status         TEXT NOT NULL DEFAULT 'scheduled',

  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_events
    ADD CONSTRAINT karate_dojo_events_kind_check
    CHECK (kind IN ('curso', 'seminario'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_events_kind_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_events
    ADD CONSTRAINT karate_dojo_events_status_check
    CHECK (status IN ('scheduled', 'completed', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_events_status_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_events
    ADD CONSTRAINT karate_dojo_events_fee_amount_check
    CHECK (fee_amount IS NULL OR fee_amount >= 0);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_events_fee_amount_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_events
    ADD CONSTRAINT karate_dojo_events_max_participants_check
    CHECK (max_participants IS NULL OR max_participants > 0);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_events_max_participants_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_events
    ADD CONSTRAINT karate_dojo_events_hours_check
    CHECK (hours IS NULL OR hours >= 0);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_events_hours_check já existe';
END $$;

CREATE INDEX IF NOT EXISTS idx_dojo_events_dojo
  ON karate_dojo_events (dojo_id, event_date DESC);

CREATE INDEX IF NOT EXISTS idx_dojo_events_dojo_kind
  ON karate_dojo_events (dojo_id, kind);

CREATE INDEX IF NOT EXISTS idx_dojo_events_federation
  ON karate_dojo_events (federation_id)
  WHERE federation_id IS NOT NULL;

DO $$ BEGIN
  CREATE TRIGGER trg_dojo_events_updated_at
    BEFORE UPDATE ON karate_dojo_events
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'trg_dojo_events_updated_at já existe';
END $$;

CREATE TABLE IF NOT EXISTS karate_dojo_event_enrollments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  event_id        UUID NOT NULL REFERENCES karate_dojo_events(id) ON DELETE CASCADE,

  -- Denormalizado de propósito — mesma razão de
  -- karate_dojo_belt_exam_results.dojo_id (264): TODA leitura do portal do
  -- dojô é escopada por dojo_id do token, e sem esta coluna toda query
  -- precisaria de JOIN só para descobrir o escopo.
  dojo_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- O ALUNO DO DOJÔ é a âncora — não o praticante da federação. É isto
  -- que faz "aluno não federado também participa" funcionar (mesma
  -- decisão da 264 para o exame de kyu).
  student_id      UUID NOT NULL REFERENCES karate_dojo_students(id) ON DELETE CASCADE,

  -- Snapshot do vínculo federativo NO MOMENTO da inscrição. NULL = aluno
  -- não federado (a inscrição existe mesmo assim). SET NULL, nunca
  -- CASCADE: apagar o praticante na federação não pode apagar a
  -- inscrição no evento do dojô.
  practitioner_id UUID REFERENCES customers(id) ON DELETE SET NULL,

  status          TEXT NOT NULL DEFAULT 'enrolled',
  fee_paid        BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Um aluno tem uma inscrição por evento (reativável — ver
  -- karateDojoEventService.enrollBatch: reinscrever um aluno cuja
  -- inscrição foi cancelada REATIVA a mesma linha, não duplica).
  UNIQUE (event_id, student_id)
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_event_enrollments
    ADD CONSTRAINT karate_dojo_event_enrollments_status_check
    CHECK (status IN ('enrolled', 'cancelled'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_event_enrollments_status_check já existe';
END $$;

CREATE INDEX IF NOT EXISTS idx_dojo_event_enrollments_event
  ON karate_dojo_event_enrollments (event_id);

CREATE INDEX IF NOT EXISTS idx_dojo_event_enrollments_student
  ON karate_dojo_event_enrollments (student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dojo_event_enrollments_dojo
  ON karate_dojo_event_enrollments (dojo_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dojo_event_enrollments_practitioner
  ON karate_dojo_event_enrollments (practitioner_id)
  WHERE practitioner_id IS NOT NULL;

COMMENT ON TABLE karate_dojo_events IS
  'F9: evento do DOJÔ (curso | seminário) — NÃO é karate_events (curso legado da federação, migration 160, órfão de UI) nem karate_dojo_belt_exams (exame de kyu, que tem regra de graduação própria e continua em tabela separada). kind é CHECK estreito de propósito: ampliar (ex.: campeonato) é migration futura de recriação do CHECK, mesma mecânica de karate_documents.owner_type (migration 265).';

COMMENT ON COLUMN karate_dojo_events.kind IS
  'F9: ''curso'' | ''seminario''. Campeonato do dojô é fase separada e NÃO entra aqui — se um dia couber neste modelo, entra como terceiro valor via migration que recria o CHECK; senão vira fonte própria na listagem unificada (karateDojoEventService.listEventsHub), que já usa um discriminador `source` para isso.';

COMMENT ON TABLE karate_dojo_event_enrollments IS
  'F9: inscrição do aluno do dojô (karate_dojo_students) num karate_dojo_events. Ancorada no aluno do dojô, não no praticante federado — aluno NÃO FEDERADO também participa. practitioner_id é snapshot do vínculo federativo no momento da inscrição, nullable.';

COMMENT ON COLUMN karate_dojo_event_enrollments.practitioner_id IS
  'F9: snapshot do vínculo federativo no momento da inscrição. NULL = aluno NÃO FEDERADO — a inscrição existe mesmo assim.';

-- ============================================================
-- FIM DA MIGRATION 268
-- ============================================================
