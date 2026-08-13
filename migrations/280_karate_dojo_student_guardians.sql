-- ============================================================
-- AURA DOJÔ — Migration 280: DOIS RESPONSÁVEIS POR ALUNO (F13)
--
-- ── NUMERAÇÃO: por que 280 e não 277 ────────────────────────
-- O número atribuído no disparo desta tarefa foi 277 ("a última aplicada
-- é a 276"). A premissa está certa sobre o BANCO e errada sobre o REPO:
-- a numeração deste repo é por ARQUIVO, e no main já existem
--   277_companies_removal_request_stamp.sql  (retenção de 60 dias)
--   278_nfe55_serie_propria_e_updated_at.sql (aplicada em prod em 12/08)
--   279_backfill_fechamentos_troca_negativa.sql (aplicada em prod em 13/08)
-- Gravar um SEGUNDO 277_ seria exatamente a colisão que a regra existe
-- para evitar. A convenção do repo é incrementar quando o número já
-- existe — precedentes 195→197 e 241→242 (o tombstone está documentado
-- no cabeçalho da própria 242). Daí 280.
--
-- (Esta migration já nasceu como 277 e foi renumerada para 279 em 12/08,
-- antes de o PR #493 tomar o 279 no main em 13/08. Nenhuma das duas
-- chegou a rodar em banco nenhum, então renumerar de novo é seguro.)
--
-- ── A DECISÃO DE PRODUTO ────────────────────────────────────
-- "Vamos usar os dois contatos separados, penso que em um caso de
--  emergência com uma criança, é bom ter o contato de ambos." (Caio,
--  12/08/2026)
--
-- Hoje a ficha do aluno tem UM responsável — karate_dojo_students.guardian_id,
-- FK singular — e a filiação (F10, migration 272) mora em mother_name /
-- father_name, TEXTO SOLTO, sem telefone e sem e-mail. Na prática: numa
-- emergência com uma criança de 10 anos, o dojô tem o nome do pai e o
-- telefone de ninguém. Isso é meio contato.
--
-- ── O MODELO: tabela de vínculo ─────────────────────────────
-- karate_dojo_student_guardians (student_id, guardian_id, relationship,
-- is_primary). N:N de verdade entre aluno e responsável.
--
-- POR QUE NÃO guardian_id_2 EM karate_dojo_students
--   Resolveria "dois" e travaria em dois. Padrasto, avó que busca na
--   saída, tio autorizado — cada um viraria uma coluna nova, um lugar novo
--   para o COALESCE errar e mais um campo para toda query de leitura
--   lembrar de trazer. "Dois" é o caso de HOJE, não o formato do problema.
--
-- POR QUE NÃO CONTATOS DENTRO DE karate_dojo_students (jsonb, ou colunas
-- father_phone/mother_phone ao lado de father_name/mother_name)
--   Porque duplicaria a PESSOA a cada filho. A planilha real do Areikan
--   tem "Caio Marmorato Toloi" e "Lucas Marmorato Toloi" com o MESMO
--   telefone: é uma mãe só. Com contato dentro do aluno, ela vira duas
--   linhas, e corrigir o telefone dela vira dois cliques hoje e N cliques
--   quando o terceiro irmão entrar. karate_dojo_guardians já é escopada
--   por DOJÔ justamente para o responsável ser UMA pessoa reaproveitável
--   entre irmãos — este PR usa isso em vez de contornar.
--
-- POR QUE NÃO REAPROVEITAR mother_name/father_name COMO "RESPONSÁVEIS"
--   São coisas diferentes e o cabeçalho do service já dizia isso desde a
--   F10: filiação é IDENTIDADE da pessoa (quem são os pais, mesmo que
--   nenhum deles seja o responsável); responsável é QUEM PAGA, QUEM RECEBE
--   COBRANÇA E QUEM ATENDE O TELEFONE NA EMERGÊNCIA. Um aluno adulto tem
--   mãe e pai e nenhum responsável. As duas colunas continuam existindo,
--   intocadas, com o mesmo significado.
--
-- ── SEM dojo_id DENORMALIZADO (ao contrário da 276) ─────────
-- A 276 denormalizou dojo_id em roster_review_items porque aquelas linhas
-- são escritas a partir do token do portal e lidas SOZINHAS. Estas não:
-- karate_dojo_student_guardians nunca é consultada isolada — ela pendura
-- por LATERAL numa linha de karate_dojo_students que JÁ foi filtrada por
-- dojo_id. Uma terceira cópia do escopo seria um terceiro lugar para
-- divergir, sem nenhuma pergunta nova respondida.
--
-- ── ADITIVA E REVERSÍVEL ────────────────────────────────────
-- Não altera NENHUMA tabela existente. Não dropa, não renomeia, não muda
-- tipo, não mexe em karate_dojo_students.guardian_id — que CONTINUA sendo
-- escrito e lido como o responsável PRINCIPAL, porque telas e serviços que
-- não foram reescritos neste PR dependem dele.
-- Reverter é `DROP TABLE karate_dojo_student_guardians;` e o banco volta
-- byte a byte ao estado anterior (ver bloco REVERSÃO no fim do arquivo).
--
-- ── ⚠️ ÍNDICE ÚNICO PARCIAL: LEIA ANTES DE ESCREVER ON CONFLICT ──
-- uq_kdsg_one_primary_per_student é PARCIAL (WHERE is_primary). O Postgres
-- só o infere se a especificação do ON CONFLICT REPETIR o predicado; sem
-- isso vem 42P10, que não é 42P01 nem 42703 (as degradações defensivas do
-- repo não o reconhecem), sobe de dentro do BEGIN e derruba a transação
-- inteira virando 500 genérico. Já travou um QA aqui em 11/08.
--   ERRADO:  ON CONFLICT (student_id) DO UPDATE ...
--   CERTO:   ON CONFLICT (student_id) WHERE is_primary DO UPDATE ...
-- O índice está catalogado em tests/unit/onConflictPartialIndexGuard.test.js;
-- a trava estática reprova quem errar.
--
-- O upsert do IMPORT não usa esse arbiter: ele mira
-- uq_kdsg_student_guardian, que é TOTAL — e índice total não leva (nem
-- pode levar) predicado.
--
-- ⚠️ CONSEQUÊNCIA OPERACIONAL DO MESMO ÍNDICE (para a rota de edição, que
-- é fase seguinte): PROMOVER um responsável a principal exige REBAIXAR o
-- atual ANTES, na mesma transação. Índice único não é DEFERRABLE: dois
-- is_primary=true no mesmo aluno estouram 23505 na hora do segundo INSERT/
-- UPDATE, não no COMMIT.
--
-- ── ON DELETE CASCADE nos DOIS lados, de propósito ──────────
-- A linha aqui é o VÍNCULO, não um fato histórico: sem o aluno ou sem o
-- responsável ela não descreve mais nada. Note que é diferente de
-- karate_dojo_students.guardian_id, que é ON DELETE SET NULL — lá apagar o
-- responsável não pode apagar o ALUNO. Aqui só o vínculo morre.
--
-- ── BACKFILL ────────────────────────────────────────────────
-- Todo aluno que hoje tem guardian_id preenchido ganha a linha
-- correspondente, marcada is_primary = true. Sem isso a ficha mostraria
-- lista vazia para quem já tem responsável — e a leitura precisaria
-- inventar o vínculo em vez de lê-lo. (O service ainda costura o legado na
-- LEITURA, mas isso é rede de segurança para alunos criados pelo form
-- DEPOIS desta migration e ANTES de o form aprender a escrever o vínculo;
-- não substitui o backfill.)
--
-- IDEMPOTENTE: CREATE ... IF NOT EXISTS + ON CONFLICT DO NOTHING no
-- backfill. Pode rodar duas vezes sem erro e sem duplicar.
--
-- NÃO aplicada em produção neste PR (aplicar via MCP antes do deploy).
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_student_guardians (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL,
  guardian_id  uuid NOT NULL,
  -- Parentesco NESTE vínculo. Separado de karate_dojo_guardians.relationship
  -- porque a mesma pessoa pode ser 'mãe' de um aluno e 'responsável legal'
  -- de outro (guarda, tutela). NULL = usa o da pessoa (a leitura faz
  -- COALESCE(sg.relationship, gg.relationship)).
  relationship text,
  -- Quem atende PRIMEIRO na emergência, e quem espelha
  -- karate_dojo_students.guardian_id (o campo legado).
  is_primary   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE karate_dojo_student_guardians
    ADD CONSTRAINT kdsg_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES karate_dojo_students(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_student_guardians
    ADD CONSTRAINT kdsg_guardian_id_fkey
    FOREIGN KEY (guardian_id) REFERENCES karate_dojo_guardians(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- IDEMPOTÊNCIA DO VÍNCULO. TOTAL (sem WHERE) de propósito: é este o
-- arbiter do upsert do import, e arbiter em índice total NÃO leva
-- predicado. Reimportar o mesmo arquivo faz DO UPDATE do parentesco,
-- nunca uma segunda linha.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kdsg_student_guardian
  ON karate_dojo_student_guardians (student_id, guardian_id);

-- No máximo UM principal por aluno. PARCIAL — releia o aviso do cabeçalho
-- antes de usar isto como arbiter de ON CONFLICT (42P10) ou de promover um
-- responsável sem rebaixar o anterior (23505).
CREATE UNIQUE INDEX IF NOT EXISTS uq_kdsg_one_primary_per_student
  ON karate_dojo_student_guardians (student_id)
  WHERE is_primary;

-- "Quais alunos são deste responsável?" — a pergunta inversa, usada pelo
-- billing familiar (F3) e pelo sync em lote do PATCH de responsável (F8),
-- que hoje ainda varre karate_dojo_students.guardian_id.
CREATE INDEX IF NOT EXISTS idx_kdsg_guardian
  ON karate_dojo_student_guardians (guardian_id);

COMMENT ON TABLE karate_dojo_student_guardians IS
  'F13 Aura Dojô (12/08/2026): vínculo N:N aluno ↔ responsável — mãe E pai, cada um com contato próprio, porque "em uma emergência com uma criança é bom ter o contato de ambos" (decisão do dono do produto). NÃO substitui karate_dojo_students.guardian_id, que continua sendo o responsável PRINCIPAL e é lido por telas/serviços da transição. Também não substitui mother_name/father_name (migration 272): filiação é identidade da pessoa; responsável é quem paga e quem atende o telefone.';

COMMENT ON COLUMN karate_dojo_student_guardians.relationship IS
  'Parentesco NESTE vínculo (mãe, pai, avó, responsável legal...). NULL = herda karate_dojo_guardians.relationship. Existe separado porque a mesma pessoa pode ter papéis diferentes para alunos diferentes.';

COMMENT ON COLUMN karate_dojo_student_guardians.is_primary IS
  'Quem atende primeiro na emergência; espelha karate_dojo_students.guardian_id. Protegido pelo índice PARCIAL uq_kdsg_one_primary_per_student — ON CONFLICT que o mire PRECISA repetir "WHERE is_primary" (senão 42P10), e promover um novo principal exige rebaixar o atual ANTES, na mesma transação (índice único não é DEFERRABLE).';

-- ── BACKFILL: o responsável que já existe vira o vínculo principal ──
INSERT INTO karate_dojo_student_guardians (student_id, guardian_id, relationship, is_primary)
SELECT s.id, s.guardian_id, g.relationship, true
  FROM karate_dojo_students s
  JOIN karate_dojo_guardians g ON g.id = s.guardian_id
 WHERE s.guardian_id IS NOT NULL
ON CONFLICT (student_id, guardian_id) DO NOTHING;

-- ── REVERSÃO (aditiva: reverter é dropar o que foi criado) ──
--   DROP TABLE IF EXISTS karate_dojo_student_guardians;
-- Nenhuma tabela pré-existente foi alterada, então não há nada a
-- restaurar: karate_dojo_students, karate_dojo_guardians e as colunas de
-- filiação continuam exatamente como estavam antes desta migration.
