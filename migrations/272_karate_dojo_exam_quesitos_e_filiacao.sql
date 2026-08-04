-- ============================================================
-- AURA KARATÊ — Migration 272: F10, a ficha de graduação REAL
--   (1) os TRÊS quesitos do exame do dojô — Kihon, Kata, Kumite — com o
--       sistema japonês tradicional de marcação (círculo/triângulo/
--       quadrado), em karate_dojo_belt_exam_results
--   (2) filiação do aluno — Mãe e Pai — em karate_dojo_students
--
-- NUMERAÇÃO: 270 (270_email_otp_verification.sql) já está no main. 271
-- está reservado por outra frente em paralelo (certificado do dojô, que
-- LÊ de karate_dojo_belt_exam_results — por isso as colunas desta
-- migration são estritamente ADITIVAS e OPCIONAIS, para não quebrar quem
-- já lê aquela tabela). O número 272 foi ATRIBUÍDO no disparo desta
-- tarefa (não escolhido como "o próximo livre" no momento da escrita) —
-- ver armadilha_agentes_paralelos_mesmo_numero_migration.
--
-- NÃO aplicada por este PR. Aplicar via Supabase MCP (apply_migration)
-- depois do merge — e depois de conferir que a 271 já rodou ou não
-- colide (esta migration não depende dela).
--
-- ============================================================
-- (1) OS TRÊS QUESITOS — Kihon, Kata, Kumite
-- ============================================================
-- migration 265 (F8.1) só grava result ('approved'|'failed') + notes na
-- linha de resultado do exame do dojô. A ficha de graduação real (Areikan
-- Karatê-Dô, Shotokan Tradicional) que o dono do produto enviou avalia os
-- TRÊS quesitos SEPARADAMENTE, com o sistema japonês tradicional de
-- marcação visual — hierarquia CONFIRMADA pelo dono do produto, do melhor
-- para o pior:
--
--     〇 círculo   >   △ triângulo   >   □ quadrado
--
-- Gravado como VALOR NOMEADO ('circulo' | 'triangulo' | 'quadrado'),
-- NUNCA o caractere Unicode: o símbolo é APRESENTAÇÃO (o app decide como
-- desenhar 〇/△/□ na tela), o dado é o CONCEITO. A hierarquia fica
-- centralizada em QUESITO_RANK, em
-- src/services/karateDojoBeltExamService.js — comentada e nomeada, para
-- relatório e ordenação futuros lerem de um lugar só. Este produto já
-- teve 7 representações divergentes da escala de faixas espalhadas pelo
-- código (ver o cabeçalho de src/utils/karateBeltScale.js, F8.0) — os
-- quesitos não repetem o erro.
--
-- TRÊS colunas OPCIONAIS (nullable, sem DEFAULT), cada uma com seu
-- próprio CHECK: dado faltante é NEUTRO, nunca pendência — um sensei pode
-- preencher só kata, ou nenhum dos três, e isso não bloqueia o
-- lançamento do resultado. Um aluno pode tirar 〇 em Kihon e □ em Kumite
-- no mesmo exame — por isso três CHECKs independentes, não um só.
--
-- result CONTINUA sendo decisão EXPLÍCITA do sensei — não é derivado de
-- média nem de nota mínima dos quesitos, e nenhum CHECK cruza quesito com
-- result. Isto é DELIBERADAMENTE diferente do CHECK
-- karate_dojo_exam_results_cert_only_approved_check (migration 265, que
-- amarra certificate_requested a result='approved'): ali é regra de
-- produto explícita sobre CERTIFICADO; aqui os quesitos são REGISTRO do
-- desempenho, não regra de aprovação — reprovado também pode ter
-- quesitos marcados (é literalmente onde eles mais importam: explicam O
-- QUE faltou).
--
-- ADITIVO sobre a 265: outro agente está criando as tabelas de
-- certificado do dojô (migration 271) que LEEM karate_dojo_belt_exam_
-- results. As três colunas abaixo são novas, nullable, sem tocar em
-- nenhuma coluna existente — quem já lê aquela tabela não quebra.
-- ============================================================

DO $$ BEGIN
  IF to_regclass('public.karate_dojo_belt_exam_results') IS NULL THEN
    RAISE EXCEPTION 'Migration 272 ABORTADA: karate_dojo_belt_exam_results nao existe.'
      USING HINT = 'Aplique as migrations 264 (F8.0, PR #451) e 265 (F8.1) antes desta.';
  END IF;
END $$;

ALTER TABLE karate_dojo_belt_exam_results
  ADD COLUMN IF NOT EXISTS kihon  text,
  ADD COLUMN IF NOT EXISTS kata   text,
  ADD COLUMN IF NOT EXISTS kumite text;

DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT karate_dojo_exam_results_kihon_check
    CHECK (kihon IS NULL OR kihon IN ('circulo', 'triangulo', 'quadrado'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_exam_results_kihon_check ja existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT karate_dojo_exam_results_kata_check
    CHECK (kata IS NULL OR kata IN ('circulo', 'triangulo', 'quadrado'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_exam_results_kata_check ja existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT karate_dojo_exam_results_kumite_check
    CHECK (kumite IS NULL OR kumite IN ('circulo', 'triangulo', 'quadrado'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_exam_results_kumite_check ja existe';
END $$;

COMMENT ON COLUMN karate_dojo_belt_exam_results.kihon IS
  'F10: quesito Kihon do exame do dojo. Sistema japones tradicional de marcacao visual: ''circulo'' > ''triangulo'' > ''quadrado'' (hierarquia centralizada em QUESITO_RANK, src/services/karateDojoBeltExamService.js). NUNCA o caractere Unicode: valor NOMEADO, a apresentacao (desenhar 〇/△/□) e problema do app. NULL = nao avaliado / nao informado (dado faltante e neutro, nunca pendencia). NAO participa de nenhuma regra de aprovacao — result continua decisao explicita do sensei, nao derivada de media dos quesitos.';

COMMENT ON COLUMN karate_dojo_belt_exam_results.kata IS
  'F10: quesito Kata do exame do dojo. Mesma escala e mesmas regras de kihon/kumite — ver comentario de kihon.';

COMMENT ON COLUMN karate_dojo_belt_exam_results.kumite IS
  'F10: quesito Kumite do exame do dojo. Mesma escala e mesmas regras de kihon/kata — ver comentario de kihon.';

-- ============================================================
-- (2) FILIAÇÃO — Mãe e Pai
-- ============================================================
-- karate_dojo_guardians (migration 242) e o RESPONSAVEL — quem paga e
-- recebe cobranca (billing familiar, F3). A ficha de graduacao real pede
-- Mae e Pai SEPARADAMENTE: isso e FILIACAO (identidade da pessoa), e pode
-- NAO coincidir com o responsavel financeiro. Decisao do dono do produto:
-- acrescentar Mae e Pai MANTENDO o responsavel como esta — nao mexe em
-- karate_dojo_guardians nem no vinculo guardian_id.
--
-- Colunas em karate_dojo_students (nao em karate_dojo_guardians nem numa
-- tabela nova): mae e pai sao dados do ALUNO, nao do responsavel — e a
-- ficha so pede o NOME de cada um (nao telefone/CPF/etc.), entao nao ha
-- caso de uso hoje que justifique uma entidade propria. Duas colunas de
-- texto simples, OPCIONAIS (mesma regra "dado faltante e neutro").
--
-- customers (praticante da federacao) NAO TEM equivalente: o dicionario
-- de identidade da federacao (migrations 148/262/266) so tem UM
-- responsavel (guardian_name/guardian_cpf/guardian_phone/
-- guardian_relationship — espelho de karate_dojo_guardians) — nenhuma
-- coluna mother_name/father_name existe do lado de customers. Por isso
-- mother_name/father_name NAO entram em IDENTITY_FIELDS nem em
-- GUARDIAN_SYNC_FIELDS (src/services/karateStudentIdentityLink.js) nesta
-- fase: nao ha coluna federativa para receber a sincronizacao. Ver a
-- discussao completa no corpo do PR sobre se/quando isso deve mudar.
--
-- GUARDA DE IDENTIDADE (src/services/karateIdentityWriteGuard.js):
-- assertGuardListsAreDisjoint() so audita colunas de CUSTOMERS (a lista
-- protegida e derivada de IDENTITY_FIELDS.fedCol + GUARDIAN_SYNC_FIELDS.
-- fedCol). Como mother_name/father_name NAO entram nessas listas (nao ha
-- fedCol correspondente), esta migration nao adiciona nenhuma coluna
-- aquela guarda e nao ha risco de colisao — a checagem no boot continua
-- passando sem alteracao nenhuma no arquivo.
-- ============================================================

DO $$ BEGIN
  IF to_regclass('public.karate_dojo_students') IS NULL THEN
    RAISE EXCEPTION 'Migration 272 ABORTADA: karate_dojo_students nao existe.'
      USING HINT = 'Aplique a migration 242 antes desta.';
  END IF;
END $$;

ALTER TABLE karate_dojo_students
  ADD COLUMN IF NOT EXISTS mother_name text,
  ADD COLUMN IF NOT EXISTS father_name text;

COMMENT ON COLUMN karate_dojo_students.mother_name IS
  'F10: nome da mae (filiacao, identidade da pessoa) — campo da ficha de graduacao real (Areikan Karate-Do, Shotokan Tradicional). DIFERENTE do responsavel (karate_dojo_guardians, migration 242): responsavel e quem paga/recebe cobranca; mae/pai podem ser pessoas diferentes do responsavel. Opcional: dado faltante e neutro, nunca pendencia. SEM equivalente em customers (federacao so tem UM responsavel) — por isso NAO entra em IDENTITY_FIELDS nem GUARDIAN_SYNC_FIELDS (karateStudentIdentityLink.js) nesta fase: nao ha coluna federativa para sincronizar.';

COMMENT ON COLUMN karate_dojo_students.father_name IS
  'F10: nome do pai (filiacao, identidade da pessoa). Ver o comentario de mother_name — mesma regra, mesma ausencia de equivalente em customers.';

-- ============================================================
-- FIM DA MIGRATION 272
-- ============================================================
