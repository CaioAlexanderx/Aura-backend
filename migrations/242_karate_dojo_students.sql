-- ============================================================
-- AURA DOJÔ — Migration 242: alunos do dojô (F2)
-- karate_dojo_guardians + karate_dojo_students
-- ------------------------------------------------------------
-- NUMERAÇÃO: nasceu como 241, mas o número foi tomado por
-- 241_karate_card_queue_out_of_queue.sql (PR #402, mergeado em 19/07/2026
-- enquanto o PR #403 estava aberto). Convenção do CLAUDE.md: numeração
-- sequencial, incrementar se já existe (precedente 195→197). O arquivo
-- 241_karate_dojo_students.sql é tombstone.
--
-- DECISÃO CENTRAL (F2 Aura Dojô, 19/07/2026): o aluno do dojô é registro
-- PRÓPRIO do dojô (company vertical karate_dojo) — NÃO escreve em
-- karate_practitioners/customers, que pertencem à FEDERAÇÃO. O merge/sync
-- com a federação será definido depois com a FPKT; por isso
-- karate_dojo_students.practitioner_id é uuid NULL e SEM FK dura
-- (vínculo futuro).
--
-- Família é entidade de primeira classe (decisão de produto para o billing
-- familiar na F3): o responsável mora em karate_dojo_guardians e um
-- responsável pode ter N alunos (students.guardian_id → guardians.id,
-- ON DELETE SET NULL — apagar o responsável não apaga o aluno).
--
-- Regra LGPD (espelha a semântica do cadastro federado, migrations 197/231):
-- menor de 18 sem responsável vinculado é BLOQUEADO no form
-- (422 MENOR_SEM_RESPONSAVEL no create/update) — mas o import em lote é
-- TOLERANTE (importa mesmo assim, com warning na resposta). Sem constraint
-- no banco: a regra depende de idade calculada em runtime.
--
-- CPF é armazenado NORMALIZADO (somente dígitos, 11 posições) — o UNIQUE
-- parcial (dojo_id, cpf) WHERE cpf IS NOT NULL depende dessa normalização
-- (feita no service, karateDojoStudentService.js).
--
-- NÃO aplicada em produção neste PR (aplicar via MCP antes do deploy).
-- Idempotente / defensiva (IF NOT EXISTS + FKs em DO $$), padrão da 240.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_guardians (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id      uuid NOT NULL,
  full_name    text NOT NULL,
  cpf          text,
  phone        text,
  email        text,
  relationship text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_guardians
    ADD CONSTRAINT karate_dojo_guardians_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_guardians_dojo
  ON karate_dojo_guardians (dojo_id);

CREATE TABLE IF NOT EXISTS karate_dojo_students (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id         uuid NOT NULL,
  full_name       text NOT NULL,
  birth_date      date,
  cpf             text,
  sex             text,
  phone           text,
  email           text,
  photo_url       text,
  belt_label      text,
  belt_order      integer,
  status          text NOT NULL DEFAULT 'active',
  guardian_id     uuid,
  consent_lgpd    boolean DEFAULT false,
  notes           text,
  -- Vínculo FUTURO com o cadastro federado (karate_practitioners/customers).
  -- SEM FK dura DE PROPÓSITO: o modelo de merge/sync com a FPKT ainda não
  -- foi definido (pode envolver outra base/outro formato de chave). Fica
  -- NULL até lá; NENHUMA rota da F2 escreve neste campo.
  practitioner_id uuid,
  enrolled_at     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_students
    ADD CONSTRAINT karate_dojo_students_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_students
    ADD CONSTRAINT karate_dojo_students_guardian_id_fkey
    FOREIGN KEY (guardian_id) REFERENCES karate_dojo_guardians(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_students
    ADD CONSTRAINT karate_dojo_students_status_check
    CHECK (status IN ('active', 'inactive'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_students_dojo
  ON karate_dojo_students (dojo_id);

CREATE INDEX IF NOT EXISTS idx_karate_dojo_students_dojo_status
  ON karate_dojo_students (dojo_id, status);

-- Dedupe por CPF dentro do dojô (CPF é opcional — regra da casa: dado
-- faltante ≠ pendência). Depende de CPF normalizado (só dígitos).
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_students_dojo_cpf
  ON karate_dojo_students (dojo_id, cpf) WHERE cpf IS NOT NULL;

COMMENT ON TABLE karate_dojo_guardians IS
  'F2 Aura Dojô: responsável (família) como entidade de primeira classe — um responsável pode ter N alunos (billing familiar na F3). Escopo por dojo_id (company karate_dojo).';

COMMENT ON TABLE karate_dojo_students IS
  'F2 Aura Dojô: aluno como registro PRÓPRIO do dojô — NÃO é o praticante federado (karate_practitioners/customers, que são da federação). practitioner_id = vínculo futuro com a FPKT (modelo de sync a definir). Menor de 18 sem guardian_id é bloqueado no form (422 MENOR_SEM_RESPONSAVEL), mas o import em lote tolera com warning.';

COMMENT ON COLUMN karate_dojo_students.practitioner_id IS
  'Vínculo FUTURO com o cadastro federado (FPKT). Sem FK dura de propósito — o modelo de merge/sync ainda não foi definido. Nenhuma rota da F2 escreve aqui.';

COMMENT ON COLUMN karate_dojo_students.cpf IS
  'CPF normalizado (somente dígitos, 11 posições) — o UNIQUE parcial (dojo_id, cpf) depende disso.';
