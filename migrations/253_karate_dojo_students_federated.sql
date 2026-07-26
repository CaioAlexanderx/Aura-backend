-- ============================================================
-- AURA DOJÔ — Migration 253: aluno FEDERADO (F5a)
-- karate_dojo_students.is_federated + karate_practitioner_requests.student_id
-- ------------------------------------------------------------
-- DECISÃO DE PRODUTO (Caio, 26/07/2026): quem marca se o aluno é federado
-- é o SENSEI, no próprio aluno. A federação CONFIRMA.
--
--   NÃO federado → cadastro PRIVADO do dojô (mensalidade, turma, presença).
--                  A federação não vê. É o caso mais comum no dia 1.
--   Federado     → o aluno também existe no cadastro da FEDERAÇÃO
--                  (karate_practitioners/customers) e é ISSO que o torna
--                  visível para a FPKT.
--
-- DUAS COLUNAS, DOIS PAPÉIS DIFERENTES (não são redundantes):
--   is_federated    = a DECLARAÇÃO do sensei ("este aluno é/será federado").
--   practitioner_id = o VÍNCULO REAL com o praticante da federação
--                     (migration 242, uuid NULL sem FK dura de propósito).
--                     practitioner_id NOT NULL é a única prova de que a
--                     federação confirmou. Toda leitura que precisa de
--                     certeza usa practitioner_id, não is_federated.
--
-- DOIS CAMINHOS PARA FEDERAR (ambos reusam o que já existe):
--   1) o aluno JÁ tem número FPKT (veio de outro dojô / já tem carteirinha):
--      o sensei informa o número, o sistema busca (lookup-fpkt, H1) e grava
--      practitioner_id no aluno.
--   2) o aluno é NOVO na federação: marcar federado abre a solicitação H1
--      (karate_practitioner_requests, migration 231); a federação aprova
--      digitando o número, o praticante nasce e o practitioner_id volta
--      para o aluno — é para isso que serve o student_id abaixo.
--
-- SER FEDERADO É PRÉ-REQUISITO das trocas da F5b (certificado, inscrição em
-- evento, candidato a exame): sem practitioner_id não existe a quem a
-- federação emitiria certificado ou de quem cobraria inscrição.
--
-- NÃO aplicada em produção neste PR (aplicar via MCP antes do deploy).
-- Idempotente (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) e
-- defensiva: o ALTER de karate_practitioner_requests roda dentro de um DO
-- $$ que tolera undefined_table (ambiente sem a migration 231).
-- ============================================================

-- ── 1) Marcador no aluno ────────────────────────────────────
ALTER TABLE karate_dojo_students
  ADD COLUMN IF NOT EXISTS is_federated boolean NOT NULL DEFAULT false;

-- Backfill: aluno que JÁ tem vínculo com a federação é federado por
-- definição (hoje nenhum tem — practitioner_id nunca foi escrito antes da
-- F5a —, mas a migration precisa ser correta se rodar depois do deploy).
UPDATE karate_dojo_students
   SET is_federated = true
 WHERE practitioner_id IS NOT NULL
   AND is_federated IS DISTINCT FROM true;

-- Filtro "Federados / Não federados" da lista de alunos (GET /dojo/students?federated=).
CREATE INDEX IF NOT EXISTS idx_karate_dojo_students_dojo_federated
  ON karate_dojo_students (dojo_id, is_federated);

-- ── 2) Origem da solicitação H1 ─────────────────────────────
-- student_id é NULL em toda solicitação criada antes da F5a (e nas que
-- nascerem fora do fluxo do aluno, ex.: o sensei cadastrando alguém que
-- não é aluno do sistema) — por isso NULL, sem FK dura e sem NOT NULL.
DO $$ BEGIN
  ALTER TABLE karate_practitioner_requests
    ADD COLUMN IF NOT EXISTS student_id uuid;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'karate_practitioner_requests ausente (migration 231 pendente) — student_id não criado';
END $$;

-- Índice parcial: só interessa localizar a solicitação PELO aluno.
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_karate_practitioner_requests_student
    ON karate_practitioner_requests (student_id) WHERE student_id IS NOT NULL;
EXCEPTION WHEN undefined_table THEN NULL; END $$;

-- ── 3) COMMENTs (o modelo mora no banco também) ─────────────
COMMENT ON COLUMN karate_dojo_students.is_federated IS
  'F5a: DECLARAÇÃO do sensei de que o aluno é federado. É só a declaração — a CONFIRMAÇÃO da federação é practitioner_id NOT NULL. Aluno não federado é cadastro privado do dojô e a federação não o enxerga.';

COMMENT ON COLUMN karate_dojo_students.practitioner_id IS
  'F5a: vínculo REAL com o praticante da federação (customers.id, sem FK dura — bases/serviços distintos). Gravado por POST /dojo/students/:sid/federate (número FPKT já existente) ou pela APROVAÇÃO da solicitação H1 (karate_practitioner_requests.student_id). DELETE /federate limpa este campo e NÃO apaga nada em karate_practitioners/customers.';

DO $$ BEGIN
  EXECUTE $c$COMMENT ON COLUMN karate_practitioner_requests.student_id IS
    'F5a: aluno do dojô (karate_dojo_students.id) que originou esta solicitação. NULL nas solicitações criadas fora do fluxo do aluno (e em todas as anteriores à F5a). Na aprovação (approve-create/approve-transfer), se preenchido, o practitioner_id resultante volta para o aluno na MESMA transação.'$c$;
EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END $$;
