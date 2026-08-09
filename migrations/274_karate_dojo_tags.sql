-- ============================================================
-- AURA DOJÔ — F11: Tags configuráveis do aluno (migration 274)
--
-- Pedido do dono do produto (09/08/2026): a planilha real do 1º dojô a
-- entrar (Associação Areikan Karatê-Dô, Araraquara/SP, 484 alunos) tem uma
-- coluna "Academia" (4 locais de treino: Escola I Karate Areikan 288,
-- Clube Araraquarense 156, SESC Areikan 24, Escola Bee Happy 16) que não
-- existe no modelo. Decisão do dono do produto: isso vira uma TAG
-- configurável pelo sensei — NÃO é uma entidade de "unidade", nem dojôs
-- separados. Um aluno pode ter VÁRIAS tags (começa em "academia" e cresce
-- para o que o sensei precisar: "bolsista", "competição", "turma da
-- manhã" etc). Gerenciada em Configurações (CRUD completo: criar,
-- renomear, desativar).
--
-- ANCORAGEM: o vínculo é em karate_dojo_students (migration 242), NUNCA em
-- customers — tag é um rótulo do DOJÔ, e um aluno não federado (sem
-- practitioner_id, portanto sem linha em customers) também precisa poder
-- ter tag. Turma (karate_dojo_classes, migration 246) é coisa DIFERENTE —
-- turma tem dia/horário e controla presença; tag é rótulo livre, sem
-- horário nem controle de frequência. As duas coexistem.
--
-- NOME ÚNICO POR DOJÔ, case-insensitive: sem isso o sensei cria "SESC" e
-- "sesc" e a contagem por tag racha em duas linhas — índice único sobre
-- (dojo_id, lower(name)).
--
-- DESATIVAR, NÃO APAGAR (decisão desta migration): uma tag em uso (>=1
-- vínculo) não pode ser excluída de verdade — sumiria do histórico de quem
-- já foi marcado com ela. Por isso o DELETE (aplicado no service, não
-- aqui) só é permitido para uma tag com ZERO vínculos — corrige o "oops"
-- de nome digitado errado sem custo de história pra preservar. Uma tag em
-- uso responde 409 TAG_EM_USO e o caminho correto é PATCH {active:false}:
-- a tag desativada MANTÉM os vínculos existentes intactos (o histórico
-- "este aluno treinou nesta academia" não muda) e só passa a ser
-- bloqueada para NOVAS atribuições.
--
-- Idempotente/aditiva: CREATE TABLE/INDEX IF NOT EXISTS, FK dentro de
-- DO $$ ... EXCEPTION WHEN duplicate_object — mesmo padrão da migration
-- 242 (karate_dojo_students).
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id    uuid NOT NULL,
  name       text NOT NULL,
  color      text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_tags
    ADD CONSTRAINT karate_dojo_tags_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_tags_dojo
  ON karate_dojo_tags (dojo_id);

CREATE INDEX IF NOT EXISTS idx_karate_dojo_tags_dojo_active
  ON karate_dojo_tags (dojo_id, active);

-- Nome único por dojô, CASE-INSENSITIVE ("SESC" e "sesc" são a MESMA tag).
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_tags_dojo_name_ci
  ON karate_dojo_tags (dojo_id, lower(name));

CREATE TABLE IF NOT EXISTS karate_dojo_student_tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL,
  tag_id     uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_student_tags
    ADD CONSTRAINT karate_dojo_student_tags_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES karate_dojo_students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_student_tags
    ADD CONSTRAINT karate_dojo_student_tags_tag_id_fkey
    FOREIGN KEY (tag_id) REFERENCES karate_dojo_tags(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UNIQUE (student_id, tag_id): o mesmo aluno não pode ter a mesma tag 2x.
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_student_tags_student_tag
  ON karate_dojo_student_tags (student_id, tag_id);

-- Índice auxiliar: "quantos alunos tem cada tag" (GROUP BY tag_id) e o
-- DELETE-só-se-sem-uso fazem SELECT/COUNT por tag_id.
CREATE INDEX IF NOT EXISTS idx_karate_dojo_student_tags_tag
  ON karate_dojo_student_tags (tag_id);
