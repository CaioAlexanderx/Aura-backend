-- ============================================================
-- AURA DOJÔ — Migration 277: DOIS responsáveis por aluno (F13)
-- karate_dojo_student_guardians (vínculo N:N aluno ↔ responsável)
-- ------------------------------------------------------------
-- DECISÃO DO DONO DO PRODUTO (Caio, 12/08/2026):
--   "Vamos usar os dois contatos separados, penso que em um caso de
--    emergência com uma criança, é bom ter o contato de ambos."
-- Ou seja: um aluno menor pode ter MÃE e PAI como responsáveis, cada um
-- com o SEU contato — e não um único responsável derivado.
--
-- POR QUE UMA TABELA DE VÍNCULO (e não guardian2_id no aluno):
--   • karate_dojo_guardians já é escopada por DOJÔ (não por aluno) — o
--     que é a decisão certa e continua valendo: irmãos compartilham o
--     MESMO responsável (a planilha real do Areikan tem casos assim, os
--     irmãos Marmorato Toloi, mesmo telefone). Uma coluna a mais no aluno
--     não representaria "N responsáveis" nem permitiria guardar o
--     PARENTESCO daquele adulto COM AQUELE aluno.
--   • relationship mora nos DOIS lados de propósito: em
--     karate_dojo_guardians ele é o rótulo geral do cadastro; aqui é o
--     parentesco DESTE adulto com ESTE aluno (a mesma pessoa pode ser
--     "mãe" de um aluno e "responsável" de um sobrinho). A leitura usa
--     COALESCE(vínculo, cadastro).
--   • Sem dojo_id nesta tabela DE PROPÓSITO: o escopo é derivado do aluno
--     (karate_dojo_students.dojo_id). Duplicar o dojô aqui criaria uma
--     terceira fonte de verdade para o escopo — e o service já entra em
--     TODA leitura/escrita por um aluno já escopado por dojo_id (mesmo
--     caminho de escopo do GET, armadilha "group shared write path").
--
-- karate_dojo_students.guardian_id CONTINUA VIVA E FUNCIONANDO — não é
-- derrubada aqui. Ela passa a significar "o responsável PRINCIPAL",
-- espelhando a linha com is_primary = true. Há código lendo dela hoje
-- (fetchGuardianSyncFields → sync de identidade com a federação,
-- updateGuardian → alunos adotados daquele responsável, listGuardians)
-- e derrubar coluna é irreversível.
--   PARA REMOVER guardian_id NO FUTURO (checklist, nenhum passo aqui):
--     1. migrar fetchGuardianSyncFields/updateGuardian/listGuardians para
--        ler o responsável principal por esta tabela (WHERE is_primary);
--     2. conferir que nenhum outro service/rota/relatório lê a coluna
--        (hoje: karateDojoStudentService.js e as duas rotas de guardians);
--     3. conferir o app (aura-app) — a ficha ainda consome `guardian`;
--     4. só então DROP COLUMN, em migration própria, depois de um ciclo
--        inteiro com a coluna já sem leitores.
--
-- ÍNDICES (armadilha ON CONFLICT × índice parcial — 42P10):
--   • uq_..._pair (student_id, guardian_id) é UNIQUE TOTAL — é ELE que
--     todo ON CONFLICT do service mira, justamente por ser total: um
--     ON CONFLICT (student_id, guardian_id) sem WHERE resolve para ele
--     sem 42P10.
--   • uq_..._primary (student_id) WHERE is_primary é PARCIAL e existe só
--     para GARANTIR "um principal por aluno". NENHUM ON CONFLICT do
--     service mira este índice — quem escreve rebaixa os outros
--     (UPDATE ... SET is_primary = false) ANTES de gravar o novo
--     principal. Se algum dia alguém quiser mirar este índice num
--     ON CONFLICT, tem de repetir o predicado: ON CONFLICT (student_id)
--     WHERE is_primary — senão estoura 42P10 → 500 genérico + ROLLBACK.
--
-- MIGRAÇÃO DE DADOS: todo guardian_id existente vira UMA linha aqui, com
-- is_primary = true. Conferido em produção antes de escrever este arquivo
-- (12/08/2026): 6 alunos, 2 com guardian_id, 0 órfãos, 0 apontando para
-- responsável de outro dojô. O backfill é re-executável (ON CONFLICT DO
-- NOTHING no par + is_primary calculado por NOT EXISTS, para não colidir
-- com o índice parcial se o aluno já tiver um principal).
--
-- relkind CONFERIDO (pg_class) antes de declarar as FKs: tanto
-- karate_dojo_students quanto karate_dojo_guardians são TABELAS ('r'),
-- não views — view não carrega constraint (já erramos isso com
-- karate_annuities, que é VIEW). O bloco de guarda abaixo repete a
-- checagem em tempo de aplicação, para o caso de o objeto mudar de tipo.
--
-- NÃO aplicada em produção neste PR (aplicar via MCP depois do merge).
-- Idempotente / defensiva (IF NOT EXISTS + FKs em DO $$), padrão da 242.
-- ============================================================

-- Guarda: os dois pais desta FK PRECISAM ser tabelas de verdade.
DO $$
DECLARE
  k_students "char";
  k_guardians "char";
BEGIN
  SELECT c.relkind INTO k_students
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'karate_dojo_students';
  SELECT c.relkind INTO k_guardians
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'karate_dojo_guardians';

  IF k_students IS NULL OR k_guardians IS NULL THEN
    RAISE EXCEPTION 'Migration 277: karate_dojo_students/karate_dojo_guardians não existem (migration 242 pendente)';
  END IF;
  IF k_students <> 'r' OR k_guardians <> 'r' THEN
    RAISE EXCEPTION 'Migration 277: esperava TABELAS (relkind r); achei students=% guardians=% — view não carrega FK/constraint', k_students, k_guardians;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS karate_dojo_student_guardians (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL,
  guardian_id  uuid NOT NULL,
  -- Parentesco DESTE adulto com ESTE aluno ('mãe', 'pai', 'avó', ...).
  -- NULL = não informado; a leitura cai para guardians.relationship.
  relationship text,
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_student_guardians
    ADD CONSTRAINT karate_dojo_student_guardians_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES karate_dojo_students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_student_guardians
    ADD CONSTRAINT karate_dojo_student_guardians_guardian_id_fkey
    FOREIGN KEY (guardian_id) REFERENCES karate_dojo_guardians(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- UNIQUE TOTAL: o mesmo adulto não entra duas vezes no mesmo aluno.
-- É o alvo de TODO ON CONFLICT do service (ver cabeçalho).
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_student_guardians_pair
  ON karate_dojo_student_guardians (student_id, guardian_id);

-- UNIQUE PARCIAL: no máximo UM principal por aluno. Ninguém mira este
-- índice em ON CONFLICT (ver cabeçalho — 42P10).
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_student_guardians_primary
  ON karate_dojo_student_guardians (student_id) WHERE is_primary;

-- "Quais alunos são deste responsável" (listGuardians, sync em lote do
-- PATCH de responsável) entra por guardian_id.
CREATE INDEX IF NOT EXISTS idx_karate_dojo_student_guardians_guardian
  ON karate_dojo_student_guardians (guardian_id);

-- ── Backfill: NENHUM vínculo existente pode se perder ──
-- Re-executável: o par colide em DO NOTHING, e is_primary só nasce true
-- se aquele aluno ainda não tiver um principal (não colide com o índice
-- parcial). O JOIN com guardians garante que só entra vínculo válido
-- (0 órfãos hoje — conferido).
INSERT INTO karate_dojo_student_guardians (student_id, guardian_id, relationship, is_primary)
SELECT s.id,
       s.guardian_id,
       g.relationship,
       NOT EXISTS (
         SELECT 1 FROM karate_dojo_student_guardians x
          WHERE x.student_id = s.id AND x.is_primary
       )
  FROM karate_dojo_students s
  JOIN karate_dojo_guardians g ON g.id = s.guardian_id
 WHERE s.guardian_id IS NOT NULL
ON CONFLICT (student_id, guardian_id) DO NOTHING;

-- Conferência declarada (aparece no log da aplicação da migration): todo
-- guardian_id preenchido tem de ter virado vínculo.
DO $$
DECLARE
  faltando integer;
  total    integer;
BEGIN
  SELECT count(*) INTO faltando
    FROM karate_dojo_students s
   WHERE s.guardian_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM karate_dojo_guardians g WHERE g.id = s.guardian_id)
     AND NOT EXISTS (
       SELECT 1 FROM karate_dojo_student_guardians sg
        WHERE sg.student_id = s.id AND sg.guardian_id = s.guardian_id
     );
  SELECT count(*) INTO total FROM karate_dojo_student_guardians;
  IF faltando > 0 THEN
    RAISE EXCEPTION 'Migration 277: % vínculo(s) de guardian_id não migraram — abortando para não perder responsável', faltando;
  END IF;
  RAISE NOTICE 'Migration 277: % vínculo(s) aluno-responsável na tabela nova', total;
END $$;

COMMENT ON TABLE karate_dojo_student_guardians IS
  'F13 Aura Dojô: vínculo N:N aluno ↔ responsável — um aluno menor pode ter mãe E pai, cada um com o SEU contato (decisão de produto 12/08/2026: contato de emergência de ambos). Escopo derivado do aluno (sem dojo_id próprio). karate_dojo_students.guardian_id continua valendo como o responsável PRINCIPAL (espelha a linha is_primary).';

COMMENT ON COLUMN karate_dojo_student_guardians.relationship IS
  'Parentesco deste adulto com ESTE aluno (mãe/pai/avó/...). NULL = não informado; a leitura cai para karate_dojo_guardians.relationship.';

COMMENT ON COLUMN karate_dojo_student_guardians.is_primary IS
  'No máximo um por aluno (índice parcial uq_..._primary). Espelhado em karate_dojo_students.guardian_id. Nenhum ON CONFLICT mira este índice — quem escreve rebaixa os outros antes (senão 42P10).';
