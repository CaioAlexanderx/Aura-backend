-- ============================================================
-- AURA KARATÊ — Migration 265: F8.1, o que faltava para o exame do dojô
--   (1) a ESCOLHA do sensei sobre o certificado, por aluno
--   (2) o ANEXO do envio (ficha de exame / comprovante) reusando
--       karate_documents — sem criar um segundo mecanismo de arquivo
--   (3) completed_at no exame do dojô
--
-- NÃO aplicada por este PR. Aplicar via Supabase MCP (apply_migration).
--
-- ⚠️ ORDEM: esta migration é ADITIVA sobre a 264 (PR #451), que cria
-- karate_dojo_belt_exams / karate_dojo_belt_exam_results. Aplicar a 264
-- ANTES. O bloco (0) aborta com mensagem acionável se a 264 não tiver
-- rodado — abortar é aceitável, aplicar meia migration não é.
--
-- 100% idempotente e aditiva: nenhum DROP de coluna, nenhum dado apagado.
-- O único DROP é o do CHECK de karate_documents.owner_type, que é
-- RECRIADO logo em seguida com um valor a mais (ALTER ... ADD VALUE não
-- existe para CHECK; a única forma de ampliar um CHECK é recriá-lo).
--
-- ============================================================
-- (1) POR QUE A ESCOLHA DO CERTIFICADO É UMA COLUNA DO RESULTADO
-- ============================================================
-- Requisito do dono do produto (31/07/2026): no lançamento do resultado,
-- POR ALUNO, o sensei diz se quer pedir o certificado à federação.
--
-- Onde isso podia morar, e por que aqui:
--   (a) tabela nova de "intenções de certificado" — RECUSADA. Já existe
--       karate_certificate_orders (migration 182) com estados e histórico;
--       uma segunda fila criaria dois lugares para responder "este aluno
--       vai receber certificado?" e a fila de aptos
--       (karateDojoFederativeService.listAptos) só conhece um deles.
--   (b) coluna no exame (lote inteiro) — RECUSADA: a escolha é por ALUNO,
--       e o próprio requisito diz isso.
--   (c) ESCOLHIDO: duas colunas no RESULTADO do aluno.
--       certificate_requested = o que o SENSEI pediu (a intenção, que é um
--         fato do exame e precisa sobreviver mesmo se o pedido falhar).
--       certificate_order_id  = o pedido REAL que nasceu daquela escolha.
--       NULL com certificate_requested = true significa "o sensei pediu e
--       o pedido não foi criado" — e a API devolve o motivo (aluno não
--       federado, dojô não conectado, já havia pedido ativo).
--
-- A FILA DE APTOS NÃO MUDA. Hoje "apto" é derivado: graduação existente
-- SEM pedido ativo para aquele nível (NOT EXISTS em
-- karate_certificate_orders). Quando o exame cria o pedido, o aluno sai da
-- fila sozinho; quem o sensei NÃO marcou continua lá e pode ser pedido
-- depois pela tela que já existe. Zero conceito novo.
--
-- ============================================================
-- (2) POR QUE O ANEXO É karate_documents, E NÃO UMA TABELA NOVA
-- ============================================================
-- A migration 207 já criou karate_documents (metadados) com o binário no
-- R2 (src/utils/r2Storage.js), e src/routes/karateDocuments.js já resolve
-- upload / listagem / URL assinada / delete com degradação a 42P01.
-- O que faltava era UMA palavra no CHECK de owner_type: o exame do dojô.
--
-- owner_type = 'dojo_belt_exam', owner_id = karate_dojo_belt_exams.id.
--
-- O ANEXO É DO LOTE, NÃO DO ALUNO — a ficha de exame é uma folha só, com
-- a lista inteira. Por isso o dono é o EXAME. Anexo por aluno não foi
-- criado: não existe requisito, e owner_type = 'dojo_belt_exam_result'
-- entraria neste mesmo CHECK no dia em que existir, sem migration nova de
-- estrutura.
--
-- SEM FK em karate_documents.owner_id de propósito: a coluna é polimórfica
-- desde a 207 (aponta para companies OU customers). Acrescentar um terceiro
-- destino não muda isso. A limpeza de órfãos continua sendo do código.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- (0) Pré-condição: a 264 tem de ter rodado
-- ────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF to_regclass('public.karate_dojo_belt_exam_results') IS NULL THEN
    RAISE EXCEPTION 'Migration 265 ABORTADA: karate_dojo_belt_exam_results nao existe.'
      USING HINT = 'Aplique a migration 264 (F8.0, PR #451) antes desta. A 265 e aditiva sobre as tabelas que a 264 cria.';
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────
-- (1) A escolha do sensei sobre o certificado, por aluno
-- ────────────────────────────────────────────────────────────
ALTER TABLE karate_dojo_belt_exam_results
  ADD COLUMN IF NOT EXISTS certificate_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS certificate_order_id  uuid;

-- FK best-effort: karate_certificate_orders nasce na migration 182 e o
-- tipo da PK é uuid. Se por qualquer motivo a tabela não existir ou o tipo
-- divergir, a coluna continua valendo (é um id de referência) e a
-- migration NÃO cai — o que não pode acontecer é o schema ficar pela
-- metade por causa de uma trava opcional.
DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT fk_dojo_exam_results_certificate_order
    FOREIGN KEY (certificate_order_id) REFERENCES karate_certificate_orders(id) ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN RAISE NOTICE 'fk_dojo_exam_results_certificate_order ja existe';
  WHEN undefined_table  THEN RAISE NOTICE 'karate_certificate_orders ausente (migration 182) — certificate_order_id fica sem FK';
  WHEN datatype_mismatch THEN RAISE NOTICE 'tipo de karate_certificate_orders.id divergente — certificate_order_id fica sem FK';
END $$;

-- Reprovado não pede certificado. (certificate_requested pode ser true com
-- order_id NULL: é o "pedi e não deu", com o motivo na resposta da API.)
DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT karate_dojo_exam_results_cert_only_approved_check
    CHECK (result = 'approved' OR (certificate_requested = false AND certificate_order_id IS NULL));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_exam_results_cert_only_approved_check ja existe';
END $$;

CREATE INDEX IF NOT EXISTS idx_dojo_belt_exam_results_cert_pending
  ON karate_dojo_belt_exam_results (dojo_id)
  WHERE certificate_requested = true AND certificate_order_id IS NULL;

COMMENT ON COLUMN karate_dojo_belt_exam_results.certificate_requested IS
  'F8.1: o SENSEI marcou este aluno para pedir certificado a federacao no lancamento do resultado. E a INTENCAO, e ela e um fato do exame: sobrevive mesmo quando o pedido nao pode ser criado (aluno nao federado, dojo nao conectado, pedido ativo ja existente). Quem NAO e marcado fica so com a graduacao registrada e continua aparecendo na fila de aptos (karateDojoFederativeService.listAptos), que e derivada de "graduacao sem pedido ativo".';

COMMENT ON COLUMN karate_dojo_belt_exam_results.certificate_order_id IS
  'F8.1: o pedido REAL nascido daquela escolha (karate_certificate_orders, migration 182). NULL com certificate_requested = true significa que o pedido nao foi criado — a API devolve o motivo por aluno, nunca pula em silencio. Aluno nao federado NUNCA tem pedido: certificado e emitido pela federacao para um PRATICANTE.';

-- ────────────────────────────────────────────────────────────
-- (2) completed_at no exame do dojô
--     A 264 já criou o status ('draft'|'completed'|'cancelled'); faltava
--     QUANDO. updated_at não serve: qualquer edição posterior o move.
-- ────────────────────────────────────────────────────────────
ALTER TABLE karate_dojo_belt_exams
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

COMMENT ON COLUMN karate_dojo_belt_exams.completed_at IS
  'F8.1: quando o resultado do lote foi lancado (status -> completed). Relancar o mesmo exame e IDEMPOTENTE e NAO move esta data: ela marca a conclusao original.';

-- ────────────────────────────────────────────────────────────
-- (3) O anexo do envio à federação — karate_documents aceita o EXAME
--
--     A 207 criou o CHECK inline (nome default
--     karate_documents_owner_type_check). Ampliar um CHECK exige recriá-lo.
--     O laço abaixo remove QUALQUER check sobre owner_type, seja qual for
--     o nome — se alguém já tiver recriado com outro nome, o ADD abaixo
--     passaria e os INSERTs continuariam falhando pelo check antigo.
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.karate_documents') IS NULL THEN
    RAISE NOTICE 'karate_documents ausente (migration 207) — anexo do exame fica indisponivel ate ela rodar';
    RETURN;
  END IF;

  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'karate_documents'
       AND n.nspname = 'public'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%owner_type%'
  LOOP
    EXECUTE format('ALTER TABLE karate_documents DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'Migration 265: CHECK % removido (sera recriado aceitando dojo_belt_exam)', r.conname;
  END LOOP;

  ALTER TABLE karate_documents
    ADD CONSTRAINT karate_documents_owner_type_check
    CHECK (owner_type IN ('dojo', 'practitioner', 'dojo_belt_exam'));

  RAISE NOTICE 'Migration 265: karate_documents.owner_type agora aceita dojo | practitioner | dojo_belt_exam';
END $$;

-- A pergunta do painel do exame é "quais anexos são DESTE exame" —
-- (owner_type, owner_id) sem o federation_id na frente. O índice da 207
-- (federation_id, owner_type, owner_id) atende porque a rota sempre tem a
-- federação do token; este aqui existe para a varredura por exame não
-- depender disso.
CREATE INDEX IF NOT EXISTS idx_karate_documents_owner_type_id
  ON karate_documents (owner_type, owner_id);

COMMENT ON COLUMN karate_documents.owner_type IS
  'F8.1: ''dojo'' (companies.id, vertical karate_dojo) | ''practitioner'' (customers.id) | ''dojo_belt_exam'' (karate_dojo_belt_exams.id — ficha de exame / comprovante do LOTE enviado a federacao). Coluna polimorfica desde a 207: owner_id NAO tem FK de proposito. Anexo por ALUNO nao existe (a ficha e do lote); se um dia existir, entra neste mesmo CHECK como ''dojo_belt_exam_result''.';

-- ============================================================
-- FIM DA MIGRATION 265
-- ============================================================
