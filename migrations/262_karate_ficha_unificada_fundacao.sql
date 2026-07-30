-- ============================================================
-- AURA KARATÊ — Migration 262: fundação da FICHA UNIFICADA (F7.0)
-- karate_dojo_students + customers + karate_belt_history
-- ------------------------------------------------------------
-- NUMERAÇÃO: o briefing pedia "255". 255 e 256 JÁ EXISTEM no repo
-- (255_karate_affiliation_requests_origin.sql e o 256 de revert), e a Onda B
-- da Loja Digital ocupou 257–261. A última APLICADA em produção é a 254, mas
-- numeração é por ARQUIVO, não por "última aplicada" — reusar 255 criaria dois
-- arquivos com o mesmo número. Este é o 262, o primeiro livre.
--
-- ------------------------------------------------------------
-- DECISÃO DE ARQUITETURA (Caio, 30/07/2026):
--
--   "A federação não faz gestão de informação. O trabalho dela é apenas
--    receber a sincronização dos dados gerenciados pelos dojôs."
--
-- O FLUXO DE INFORMAÇÃO SOBE: dojô → federação.
--   O DOJÔ é dono de tudo que descreve a PESSOA (nome, nascimento, CPF, RG,
--   sexo, contato, endereço, foto, responsável).
--   A FEDERAÇÃO é dona só do que ela EMITE (matrícula FPKT, homologação de
--   dan pela banca, certificado, anuidade, papéis federativos).
--
-- Hoje o código faz o contrário: karate_dojo_students (dojô, migr 242) e
-- customers (federação, migr 148) são cadastros independentes, ligados por um
-- practitioner_id uuid SEM FK e SEM unicidade global. Com 6 alunos de dojô e
-- 9.783 praticantes, o estrago ainda não existe — é o momento de fundar.
--
-- Esta migration é 100% ADITIVA e IDEMPOTENTE. NENHUM backfill destrutivo,
-- NENHUM DROP, NENHUM ALTER TYPE. Ela apenas cria o lugar onde o dado passa a
-- morar e as travas de integridade que faltavam.
--
-- NÃO aplicada em produção neste PR (aplicar via MCP antes/depois do deploy —
-- o backend sobe defensivo a 42703 e degrada sozinho enquanto ela não roda).
--
-- ------------------------------------------------------------
-- ESCOLHAS, E POR QUÊ (a parte que precisa ser revisada)
--
-- (a) MARCADOR DE GESTÃO — customers.karate_identity_managed_by (+ _dojo_id)
--     Escolhi ENUM DE TEXTO COM CHECK + coluna do dojô gestor, e não só a
--     referência ao dojô, porque "dojo_id NULL" seria AMBÍGUO: significaria ao
--     mesmo tempo "a federação gerencia" e "ainda não sabemos". Um marcador
--     explícito transforma o estado de hoje numa AFIRMAÇÃO, não numa ausência.
--     Default 'federation' preserva EXATAMENTE o comportamento atual para os
--     9.783 praticantes existentes: hoje quem digita a ficha deles é a FPKT.
--     Prefixo karate_ porque customers é tabela COMPARTILHADA entre verticais
--     (15.488 linhas, só 9.783 de karatê) — mesma convenção de
--     karate_registration_number / karate_photo_url, que já vivem aqui.
--     ATENÇÃO: karate_identity_dojo_id É DIFERENTE de customers.dojo_id.
--       dojo_id                 = onde o praticante TREINA (visão da federação).
--       karate_identity_dojo_id = quem é DONO DA FICHA daquela pessoa.
--     Um praticante pode treinar num dojô que não usa o Aura: dojo_id
--     preenchido, gestão ainda 'federation'. Quando o dojô adota o aluno
--     (F7.1), vira 'dojo' + o id do dojô.
--
-- (b) IDENTIDADE NO ALUNO DO DOJÔ — rg + endereço + foto
--     Endereço no MESMO vocabulário que customers já usa no karatê
--     (zip_code, street, number, complement, neighborhood, city, state), para
--     que a sincronização da F7.2 seja cópia coluna-a-coluna de mesmo nome, e
--     não um mapa de tradução que alguém vai errar.
--     FOTO — karate_dojo_students.photo_url é COLUNA MORTA (nenhuma UI escreve;
--     a foto real da carteirinha é customers.karate_photo_url). NÃO reaproveitei:
--       1. photo_url já está na whitelist (validateStudentPayload/UPDATABLE_COLS)
--          e em toda resposta da API — reaproveitá-la mudaria em silêncio o
--          significado de um campo que já existe no contrato do app;
--       2. o nome coerente com o lado da federação (karate_photo_url dos dois
--          lados) é justamente o que faz a F7.2 ser trivial;
--       3. dropar photo_url seria DDL destrutivo, que esta migration não faz.
--     photo_url fica DEPRECADA por COMMENT e a leitura passa a devolver
--     COALESCE(karate_photo_url, photo_url) — nada quebra, nada some.
--
-- (c) INTEGRIDADE DO VÍNCULO — UNIQUE global + FK em practitioner_id
--     A migration 253 escreveu "sem FK dura de propósito — bases/serviços
--     distintos". Isso está SUPERADO por esta decisão de arquitetura: os dois
--     cadastros vivem no MESMO banco e são as duas metades da MESMA pessoa.
--     Sem FK, practitioner_id aponta para um customers.id apagado sem ninguém
--     notar. Sem UNIQUE GLOBAL, o mesmo praticante pode ser reivindicado por
--     alunos de DOJÔS DIFERENTES — a checagem atual é
--     `WHERE dojo_id = $1 AND practitioner_id = $2`, ou seja, só protege dentro
--     do mesmo dojô.
--     ON DELETE SET NULL (nunca CASCADE): se a federação apagar o praticante, o
--     ALUNO DO DOJÔ CONTINUA EXISTINDO e só perde o vínculo. Deletar em cascata
--     o cadastro do dojô a partir de um ato da federação seria exatamente a
--     inversão de fluxo que esta arquitetura veio consertar.
--     A criação é PRECEDIDA de uma checagem que ABORTA com mensagem clara se
--     houver dado violando — abortar é aceitável, corromper não.
--     Medido em produção em 30/07/2026, antes de escrever isto:
--       alunos de dojô ................................. 6
--       com practitioner_id NOT NULL ................... 0
--       practitioner_id reivindicado por >1 aluno ...... 0
--       practitioner_id órfão (customers inexistente) .. 0
--     Ou seja: a trava entra num terreno limpo. É agora ou nunca.
--
-- (d) ORIGEM DA GRADUAÇÃO — karate_belt_history.source (+ source_dojo_id)
--     Hoje é impossível saber se uma graduação veio da banca, de registro
--     manual ou de import. (Já houve um P0 causado por uma query que assumia
--     kbh.source — a coluna nunca existiu. Agora existe, e é NULLABLE.)
--     SEM BACKFILL INVENTADO: as 13.781 linhas existentes ficam com source
--     NULL = ORIGEM DESCONHECIDA. Motivo concreto, não preguiça: exam_id é NULL
--     em 13.781 de 13.781 linhas (0 com exame vinculado), então NÃO EXISTE
--     nenhum sinal no dado que separe "exame da federação" de "import da
--     planilha histórica". Carimbar todo mundo como 'import' seria inventar um
--     fato sobre a graduação de 9.783 pessoas. NULL é a verdade.
--     Quem consultar source DEVE tratar NULL como desconhecido, nunca como falso.
--
-- (e) DICIONÁRIO ÚNICO DE SEXO — hoje há TRÊS vocabulários:
--       karate_dojo_students.sex ..... 'M' | 'F' | 'other'      (sem CHECK)
--       customers.sex ................ 'masculino'|'feminino'|'outro' (CHECK, migr 205)
--       customers.gender ............. 'M' | 'F' | 'outro'      (CHECK, migr 050, odonto)
--     CANÔNICO ESCOLHIDO: 'masculino' | 'feminino' | 'outro'.
--     Por quê esse e não M/F/other:
--       - customers.sex JÁ tem CHECK exatamente nesses valores e 189 linhas
--         reais gravadas; mudar esse lado exigiria converter dado + trocar
--         CHECK, que é justamente o DDL destrutivo que esta fase não faz;
--       - karate_dojo_students.sex não tem CHECK nenhum e tem 1 valor distinto
--         em 6 linhas — é o lado barato de acomodar;
--       - customers.gender é herança morta do odonto: 1 linha não-nula em
--         15.488. Fica DEPRECADA por COMMENT (sem DROP).
--     O QUE ESTA MIGRATION FAZ: adiciona em karate_dojo_students.sex um CHECK
--     PERMISSIVO que aceita OS DOIS vocabulários. Não é meio-termo preguiçoso:
--     hoje a coluna aceita QUALQUER string, então o CHECK já fecha a porta para
--     um QUARTO vocabulário aparecer, sem invalidar as linhas existentes.
--     O QUE FICA PARA DEPOIS (F7.2): converter o dado do dojô para o canônico e
--     estreitar o CHECK. Enquanto isso, o CÓDIGO normaliza na borda: a API do
--     dojô passa a ACEITAR os dois vocabulários e continua GRAVANDO M/F/other
--     (zero mudança visível), e o approve-create GRAVA o canônico em customers.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- (a) Quem gerencia a ficha daquela pessoa
-- ────────────────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS karate_identity_managed_by text NOT NULL DEFAULT 'federation';

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS karate_identity_dojo_id uuid;

DO $$ BEGIN
  ALTER TABLE customers
    ADD CONSTRAINT customers_karate_identity_managed_by_check
    CHECK (karate_identity_managed_by IN ('federation', 'dojo'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'customers_karate_identity_managed_by_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE customers
    ADD CONSTRAINT fk_customers_karate_identity_dojo
    FOREIGN KEY (karate_identity_dojo_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'fk_customers_karate_identity_dojo já existe';
END $$;

-- Coerência: dizer "quem gerencia é o dojô" sem dizer QUAL dojô não é um
-- estado válido. O caminho inverso é permitido (gestão da federação com
-- karate_identity_dojo_id NULL é o estado default dos 9.783).
DO $$ BEGIN
  ALTER TABLE customers
    ADD CONSTRAINT customers_karate_identity_coherent
    CHECK (karate_identity_managed_by <> 'dojo' OR karate_identity_dojo_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'customers_karate_identity_coherent já existe';
END $$;

-- Índice parcial: a pergunta da F7.2 é "quais praticantes ESTE dojô gerencia?".
-- Ninguém precisa de índice para os 9.783 em 'federation' (é o default).
CREATE INDEX IF NOT EXISTS idx_customers_karate_identity_dojo
  ON customers (karate_identity_dojo_id)
  WHERE karate_identity_dojo_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- (b) Identidade que faltava no aluno do dojô
-- ────────────────────────────────────────────────────────────
ALTER TABLE karate_dojo_students
  ADD COLUMN IF NOT EXISTS rg               text,
  ADD COLUMN IF NOT EXISTS zip_code         text,
  ADD COLUMN IF NOT EXISTS street           text,
  ADD COLUMN IF NOT EXISTS number           text,
  ADD COLUMN IF NOT EXISTS complement       text,
  ADD COLUMN IF NOT EXISTS neighborhood     text,
  ADD COLUMN IF NOT EXISTS city             text,
  ADD COLUMN IF NOT EXISTS state            text,
  ADD COLUMN IF NOT EXISTS karate_photo_url text;

-- ────────────────────────────────────────────────────────────
-- (c) Integridade do vínculo aluno ↔ praticante
--     Checagem PRIMEIRO: se houver dado violando, aborta com mensagem
--     acionável. Deploy que quebra é ruim; banco corrompido é pior.
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_dupes   bigint;
  v_orphans bigint;
BEGIN
  SELECT count(*) INTO v_dupes
    FROM (SELECT practitioner_id
            FROM karate_dojo_students
           WHERE practitioner_id IS NOT NULL
           GROUP BY practitioner_id
          HAVING count(*) > 1) d;

  SELECT count(*) INTO v_orphans
    FROM karate_dojo_students s
   WHERE s.practitioner_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = s.practitioner_id);

  IF v_dupes > 0 OR v_orphans > 0 THEN
    RAISE EXCEPTION
      'Migration 262 ABORTADA: % praticante(s) reivindicado(s) por mais de um aluno e % vinculo(s) orfao(s) em karate_dojo_students.practitioner_id.',
      v_dupes, v_orphans
      USING HINT = 'Resolva os conflitos antes de re-rodar. Duplicados: SELECT practitioner_id, array_agg(id) FROM karate_dojo_students WHERE practitioner_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1; Orfaos: SELECT s.id, s.dojo_id, s.practitioner_id FROM karate_dojo_students s WHERE s.practitioner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = s.practitioner_id);';
  END IF;

  RAISE NOTICE 'Migration 262: practitioner_id sem duplicatas e sem orfaos — seguro criar UNIQUE + FK.';
END $$;

-- UNIQUE GLOBAL (parcial): um praticante da federação pertence a UM aluno de
-- UM dojô. A checagem antiga (dojo_id + practitioner_id) só protegia dentro do
-- mesmo dojô e deixava dois dojôs reivindicarem a mesma pessoa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_students_practitioner
  ON karate_dojo_students (practitioner_id)
  WHERE practitioner_id IS NOT NULL;

-- FK com ON DELETE SET NULL — ver justificativa (c) no cabeçalho.
DO $$ BEGIN
  ALTER TABLE karate_dojo_students
    ADD CONSTRAINT fk_karate_dojo_students_practitioner
    FOREIGN KEY (practitioner_id) REFERENCES customers(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'fk_karate_dojo_students_practitioner já existe';
END $$;

-- ────────────────────────────────────────────────────────────
-- (d) Origem da graduação
-- ────────────────────────────────────────────────────────────
ALTER TABLE karate_belt_history
  ADD COLUMN IF NOT EXISTS source         text,
  ADD COLUMN IF NOT EXISTS source_dojo_id uuid;

DO $$ BEGIN
  ALTER TABLE karate_belt_history
    ADD CONSTRAINT karate_belt_history_source_check
    CHECK (source IS NULL OR source IN ('exam_federation', 'exam_dojo', 'manual', 'import'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_belt_history_source_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_belt_history
    ADD CONSTRAINT fk_karate_belt_history_source_dojo
    FOREIGN KEY (source_dojo_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'fk_karate_belt_history_source_dojo já existe';
END $$;

CREATE INDEX IF NOT EXISTS idx_belt_history_source
  ON karate_belt_history (source)
  WHERE source IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- (e) Dicionário de sexo — CHECK permissivo no lado do dojô
-- ────────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE karate_dojo_students
    ADD CONSTRAINT karate_dojo_students_sex_check
    CHECK (sex IS NULL OR sex IN ('M', 'F', 'other', 'masculino', 'feminino', 'outro'));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_students_sex_check já existe';
END $$;

-- ────────────────────────────────────────────────────────────
-- COMMENTs — o modelo mora no banco também
-- ────────────────────────────────────────────────────────────
COMMENT ON COLUMN customers.karate_identity_managed_by IS
  'F7.0: QUEM gerencia a ficha (dados da PESSOA) deste praticante. ''federation'' = a FPKT digita/mantém (comportamento histórico e default dos 9.783 existentes); ''dojo'' = o dojô adotou o aluno e passou a ser a fonte da identidade (karate_identity_dojo_id diz qual). O fluxo de informação SOBE: dojô -> federação. Só tem significado para praticantes de karatê; para os demais clientes de customers o default é ruído inerte.';

COMMENT ON COLUMN customers.karate_identity_dojo_id IS
  'F7.0: dojô GESTOR da ficha (companies.id). NÃO confundir com customers.dojo_id, que é onde o praticante TREINA na visão da federação. Um praticante pode treinar num dojô que não usa o Aura: dojo_id preenchido e gestão ainda ''federation''. Obrigatório quando karate_identity_managed_by = ''dojo'' (CHECK customers_karate_identity_coherent).';

COMMENT ON COLUMN customers.gender IS
  'DEPRECADA (F7.0). Herança do vertical odonto (migration 050, vocabulário M/F/outro), 1 linha não-nula em 15.488. O campo canônico de sexo é customers.sex (''masculino''|''feminino''|''outro'', migration 205). Não escrever aqui. DROP fica para uma fase posterior.';

COMMENT ON COLUMN customers.sex IS
  'F7.0: dicionário CANÔNICO de sexo em todo o produto: ''masculino'' | ''feminino'' | ''outro''. karate_dojo_students.sex ainda grava o vocabulário curto do dojô (M/F/other) e o código converte na borda (src/utils/personIdentity.js). A unificação do dado do dojô é F7.2.';

COMMENT ON COLUMN karate_dojo_students.sex IS
  'F7.0: vocabulário do dojô (''M''|''F''|''other''). O CANÔNICO do produto é o de customers.sex (''masculino''|''feminino''|''outro''); o CHECK aqui aceita OS DOIS de propósito, para o schema já receber o canônico enquanto a conversão do dado não acontece (F7.2). A borda de escrita normaliza via src/utils/personIdentity.js: aceita os dois e grava M/F/other (zero mudança visível no app).';

COMMENT ON COLUMN karate_dojo_students.rg IS
  'F7.0: RG do aluno. O DOJÔ é dono da identidade da pessoa; espelha customers.rg no lado da federação.';

COMMENT ON COLUMN karate_dojo_students.karate_photo_url IS
  'F7.0: foto de carteirinha do aluno. Mesmo NOME da coluna equivalente em customers.karate_photo_url de propósito — a sincronização dojô->federação (F7.2) é cópia coluna-a-coluna. SUBSTITUI karate_dojo_students.photo_url, que nunca foi escrita por nenhuma UI.';

COMMENT ON COLUMN karate_dojo_students.photo_url IS
  'DEPRECADA (F7.0). Coluna morta desde a migration 242: nenhuma UI jamais escreveu nela. Substituída por karate_photo_url (nome coerente com o lado da federação). A leitura da API devolve COALESCE(karate_photo_url, photo_url) para não perder nada. Mantida por ora — esta migration não faz DDL destrutivo.';

COMMENT ON COLUMN karate_dojo_students.practitioner_id IS
  'F7.0: vínculo com o praticante da federação (customers.id). AGORA COM FK (ON DELETE SET NULL) e UNIQUE GLOBAL PARCIAL — supera a decisão da migration 253 (''sem FK dura de propósito''), que valia quando os dois cadastros eram tratados como bases distintas. Sem UNIQUE global, alunos de DOJÔS DIFERENTES podiam reivindicar o mesmo praticante (a checagem do service era só dentro do mesmo dojô). SET NULL, nunca CASCADE: apagar o praticante na federação não pode apagar o aluno do dojô.';

COMMENT ON COLUMN karate_belt_history.source IS
  'F7.0: origem da graduação — ''exam_federation'' (banca da federação) | ''exam_dojo'' (exame do dojô) | ''manual'' (lançamento avulso) | ''import'' (carga histórica). NULL = ORIGEM DESCONHECIDA, e é o valor de TODAS as 13.781 linhas anteriores a esta migration: exam_id é NULL em 100% delas, então não existe sinal no dado que separe banca de import — carimbar um valor seria inventar um fato. Quem consulta DEVE tratar NULL como desconhecido, nunca como falso.';

COMMENT ON COLUMN karate_belt_history.source_dojo_id IS
  'F7.0: dojô que REGISTROU a graduação (companies.id). NULL quando a graduação é da federação, quando o dojô é desconhecido, ou em qualquer linha anterior a esta migration.';
