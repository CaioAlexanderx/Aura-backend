-- ============================================================
-- AURA KARATÊ — Migration 264: F8.0, a fundação da graduação
--   (1) corrige a ORDEM Roxa × Azul Claro na view canônica
--   (2) tira o GRAU de dentro do texto de belt_name
--   (3) cria o lugar onde mora a graduação feita pelo DOJÔ (F8.1)
--
-- NÃO aplicada por este PR. Aplicar via Supabase MCP (apply_migration).
-- 100% idempotente e ADITIVA: nenhum DROP, nenhum ALTER TYPE, nenhum
-- dado apagado. O único UPDATE é o backfill descrito abaixo, e ele só
-- toca linhas onde belt_kyu E belt_dan estão NULL.
--
-- ============================================================
-- A ESCALA OFICIAL DA FPKT (confirmada pelo Caio em 31/07/2026)
-- ============================================================
--   10º kyu ... Branca            4º kyu ... Azul Escuro
--    9º kyu ... Amarela           3º kyu ... Marrom 3º kyu
--    8º kyu ... Laranja           2º kyu ... Marrom 2º kyu
--    7º kyu ... Verde             1º kyu ... Marrom 1º kyu
--    6º kyu ... Azul Claro          —   ... Preta, 1º ao 10º dan
--    5º kyu ... Roxa
--
--   "Branca, Amarela, Laranja, Verde, Azul Claro, Roxa, Azul Escuro,
--    Marrom (3 Kyus) e Preta."
--
-- Vale para belt_schema = 'fpkt_shotokan'. A escala 'legacy' (7 kyus,
-- com Vermelha) é OUTRA e continua intocada — ver seção (3).
--
-- ============================================================
-- (1) O BUG: a view canônica ordena Roxa e Azul Claro invertidas
-- ============================================================
-- A migration 229 escreveu, no CASE de karate_current_belt:
--     WHEN 'roxo'       THEN 5
--     WHEN 'azul_claro' THEN 6
-- ou seja, Roxa ABAIXO de Azul Claro. Pela escala oficial é o contrário:
-- Azul Claro é 6º kyu e vem ANTES de Roxa, que é 5º kyu.
--
-- Por que isso importa: karate_current_belt é o que responde "qual é a
-- faixa ATUAL deste praticante". Enquanto a ordem estiver invertida,
-- quem tem as DUAS faixas no histórico pode aparecer com a faixa errada
-- na carteirinha, no certificado, no dashboard e na elegibilidade a
-- exame.
--
-- Evidência medida em produção em 31/07/2026:
--   • 32 praticantes têm Roxa E Azul Claro no histórico.
--   • Destes, 3 são casos LIMPOS (as duas em 'fpkt_shotokan', com data
--     real, sem a data-sentinela '1900-01-01' usada pelo import) — e
--     nos 3 a Roxa vem DEPOIS da Azul Claro. Confirma a escala oficial.
--   • Os outros 28 são Roxa em 'legacy' com data-sentinela migrando
--     para a escala nova: ruído de carga histórica, não evidência de
--     ordem.
--   • Simulando a view antiga contra a nova sobre as 13.781 linhas:
--     26 praticantes mudam de faixa atual, TODOS de Azul Claro para
--     Roxa. Nenhum regride. É correção de faixa exibida a menor.
--
-- Reforço independente: a própria tabela de requisitos da FPKT (seed da
-- migration 150) SEMPRE esteve certa — tem o degrau 6kyu → 5kyu
-- comentado como "Azul Claro → Roxo" e 5kyu → 4kyu como "Roxo → Azul
-- Escuro". Quem divergiu foi a view (e os dois mapas de JS que a
-- copiaram). O fix é trocar os dois pesos; todos os demais ficam iguais.
--
-- ============================================================
-- (2) GRAU DEIXA DE VIVER EM REGEX DE TEXTO
-- ============================================================
-- Hoje belt_level guarda só a COR ('marrom', 'preta') e o grau vive
-- dentro do texto de belt_name ("Preta 1°", "Marrom 3°kyu"), extraído
-- por regexp_replace na própria ORDER BY da view. Esta migration cria
-- belt_kyu e belt_dan em karate_belt_history, e duas funções IMMUTABLE
-- que implementam a dedução em UM lugar só (usadas pelo backfill, pela
-- view e pelos testes):
--     karate_belt_dan_from_name(belt_level, belt_name)
--     karate_belt_kyu_from_name(belt_level, belt_name, belt_schema)
--
-- ── CRITÉRIO DO BACKFILL: só o que é DEDUTÍVEL ─────────────
-- Contagens medidas em produção em 31/07/2026 (13.781 linhas):
--
--   R1  belt_level='preta' e há número em belt_name → belt_dan
--       "Preta 3°" → dan 3 ............................  895 linhas
--
--   R2  belt_name contém "kyu" e um número (qualquer cor
--       que não preta) → belt_kyu
--       "Marrom 3°kyu" → kyu 3 ........................   17 linhas
--
--   R3  belt_schema='fpkt_shotokan' e a cor tem UM ÚNICO kyu
--       na escala oficial → belt_kyu da cor
--       branca=10, amarela=9, laranja=8, verde=7,
--       azul_claro=6, roxo=5, azul_escuro=4 ........... 8.614 linhas
--
--   —   NADA (belt_kyu e belt_dan ficam NULL) ......... 4.255 linhas
--         •   762 "Marrom" sem grau nenhum (557 fpkt + 205 legacy)
--         • 3.493 linhas da escala 'legacy'
--
--   Soma: 895 + 17 + 8.614 + 4.255 = 13.781. ✔
--
-- ── POR QUE R3 EXISTE, E POR QUE PARA NO MARROM ────────────
-- R3 não inventa nada: na escala fpkt_shotokan cada uma dessas cores
-- corresponde a EXATAMENTE UM kyu. Saber que a faixa é Verde É saber
-- que é 7º kyu — é leitura da escala oficial, não palpite.
-- Marrom é o oposto: 3º, 2º e 1º kyu dividem a MESMA cor. As 762 linhas
-- "Marrom" sem grau ficam NULL = GRAU DESCONHECIDO. Carimbar 3º kyu (ou
-- 1º) em 762 pessoas seria inventar a graduação de 762 pessoas — e é
-- exatamente o buraco que a F8.1 vai fechar perguntando ao sensei, não
-- adivinhando aqui.
-- Mesma lógica das 3.493 linhas 'legacy': a ordem interna dos 7 kyus do
-- sistema antigo (que inclui a Vermelha) não está documentada em lugar
-- nenhum do repo. NULL é a verdade.
--
-- NULL nunca significa "sem graduação": significa "grau desconhecido".
-- Quem consultar DEVE tratar assim — igual ao contrato de
-- karate_belt_history.source (migration 262).
--
-- ── A VIEW NÃO PODE PERDER NINGUÉM ────────────────────────
-- O desempate da view lê belt_dan/belt_kyu quando existem e CAI DE VOLTA
-- para a leitura do belt_name quando são NULL (exatamente o que a 229
-- fazia). Ninguém com grau NULL some da faixa atual: DISTINCT ON sempre
-- devolve uma linha por (student_id, federation_id). Conferido no ensaio
-- desta migration em produção (transação revertida, 31/07/2026): a view
-- devolveu as mesmas 9.783 linhas antes e depois.
--
-- ============================================================
-- (3) ONDE MORA A GRADUAÇÃO DO DOJÔ (schema para a F8.1)
-- ============================================================
-- karate_dojo_belt_exams        — o exame do dojô
-- karate_dojo_belt_exam_results — o resultado por aluno
--
-- REQUISITO DE PRODUTO: aluno NÃO FEDERADO também é graduado. Ele não
-- tem practitioner_id, e karate_belt_history exige um praticante
-- (student_id REFERENCES customers). Por isso o registro do dojô existe
-- por conta própria, referenciando karate_dojo_students. Quando o aluno
-- É federado, a F8.1 grava TAMBÉM uma linha em karate_belt_history com
-- source='exam_dojo' (coluna criada pela 262) e guarda o id em
-- belt_history_id. A ESCRITA é F8.1 — aqui é só o lugar.
--
-- A FRONTEIRA DO SENSEI ESTÁ NO SCHEMA, não só no código: um CHECK
-- proíbe destino 'preta' e não existe coluna de dan no resultado. Faixa
-- preta é banca da federação — e a própria tabela de requisitos da FPKT
-- diz isso no degrau 1kyu → 1dan ("Exame estadual obrigatório com banca
-- designada pela FPKT", seed da migration 150).
--
-- FORA DE ESCOPO NESTE PR: rotas, telas e qualquer mudança no fluxo de
-- candidatos/banca da federação.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Colunas de grau em karate_belt_history
--    (a tabela não tem mais triggers de imutabilidade desde a 199)
-- ────────────────────────────────────────────────────────────
ALTER TABLE karate_belt_history
  ADD COLUMN IF NOT EXISTS belt_kyu smallint,
  ADD COLUMN IF NOT EXISTS belt_dan smallint;

DO $$ BEGIN
  ALTER TABLE karate_belt_history
    ADD CONSTRAINT karate_belt_history_belt_kyu_check
    CHECK (belt_kyu IS NULL OR belt_kyu BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_belt_history_belt_kyu_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_belt_history
    ADD CONSTRAINT karate_belt_history_belt_dan_check
    CHECK (belt_dan IS NULL OR belt_dan BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_belt_history_belt_dan_check já existe';
END $$;

-- Uma graduação é kyu OU dan, nunca os dois. (Os dois NULL é permitido:
-- é o "grau desconhecido" das 4.255 linhas.)
DO $$ BEGIN
  ALTER TABLE karate_belt_history
    ADD CONSTRAINT karate_belt_history_degree_exclusive_check
    CHECK (belt_kyu IS NULL OR belt_dan IS NULL);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_belt_history_degree_exclusive_check já existe';
END $$;

-- Dan só existe em faixa preta. lower() é IMMUTABLE, pode entrar em CHECK.
DO $$ BEGIN
  ALTER TABLE karate_belt_history
    ADD CONSTRAINT karate_belt_history_dan_only_preta_check
    CHECK (belt_dan IS NULL OR lower(belt_level) = 'preta');
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_belt_history_dan_only_preta_check já existe';
END $$;

CREATE INDEX IF NOT EXISTS idx_belt_history_dan
  ON karate_belt_history (belt_dan)
  WHERE belt_dan IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_belt_history_kyu
  ON karate_belt_history (belt_kyu)
  WHERE belt_kyu IS NOT NULL;

-- ────────────────────────────────────────────────────────────
-- 2. Dedução do grau — UMA implementação, em SQL
--    Espelho exato de src/utils/karateBeltScale.js
--    (parseDegreeFromName / kyuFromColor / resolveDegree).
-- ────────────────────────────────────────────────────────────

-- Primeiro número do texto, aceito só entre 1 e 10.
-- Mais estrito que o regexp_replace da 229 (que concatenava TODOS os
-- dígitos: "Preta 1° 2020" viraria 12020). Nas 912 linhas com dígito em
-- belt_name as duas leituras dão o MESMO resultado — conferido em
-- 31/07/2026 —, então a troca não move nenhum dado real.
CREATE OR REPLACE FUNCTION karate_belt_degree_in_name(p_belt_name text)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN n BETWEEN 1 AND 10 THEN n::smallint
           ELSE NULL
         END
  FROM (SELECT NULLIF(substring(COALESCE(p_belt_name, '') from '([0-9]+)'), '')::int AS n) s;
$$;

-- R1 — dan escrito no nome, só para faixa preta.
CREATE OR REPLACE FUNCTION karate_belt_dan_from_name(p_belt_level text, p_belt_name text)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           WHEN lower(COALESCE(p_belt_level, '')) = 'preta'
             THEN karate_belt_degree_in_name(p_belt_name)
           ELSE NULL
         END;
$$;

-- R2 (nome) e R3 (cor de kyu único, só em fpkt_shotokan).
-- Marrom → NULL: 3 kyus na mesma cor.
-- legacy → NULL: mapa kyu→cor do sistema antigo é desconhecido.
CREATE OR REPLACE FUNCTION karate_belt_kyu_from_name(
  p_belt_level  text,
  p_belt_name   text,
  p_belt_schema text
)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
           -- preta nunca tem kyu
           WHEN lower(COALESCE(p_belt_level, '')) = 'preta' THEN NULL
           -- R2: grau escrito no nome ("Marrom 3°kyu")
           WHEN COALESCE(p_belt_name, '') ILIKE '%kyu%'
                AND karate_belt_degree_in_name(p_belt_name) IS NOT NULL
             THEN karate_belt_degree_in_name(p_belt_name)
           -- R3: cor de kyu único na escala oficial
           WHEN COALESCE(p_belt_schema, 'fpkt_shotokan') = 'fpkt_shotokan' THEN
             CASE lower(COALESCE(p_belt_level, ''))
               WHEN 'branca'       THEN 10::smallint
               WHEN 'amarela'      THEN  9::smallint
               WHEN 'laranja'      THEN  8::smallint
               WHEN 'verde'        THEN  7::smallint
               WHEN 'azul_claro'   THEN  6::smallint
               WHEN 'roxo'         THEN  5::smallint
               WHEN 'roxa'         THEN  5::smallint
               WHEN 'azul_escuro'  THEN  4::smallint
               ELSE NULL  -- marrom (3 kyus) e qualquer cor desconhecida
             END
           ELSE NULL
         END;
$$;

COMMENT ON FUNCTION karate_belt_degree_in_name(text) IS
  'F8.0: primeiro número de belt_name, aceito só entre 1 e 10. Base de karate_belt_dan_from_name/karate_belt_kyu_from_name.';
COMMENT ON FUNCTION karate_belt_dan_from_name(text, text) IS
  'F8.0 regra R1: dan escrito em belt_name quando belt_level = ''preta'' ("Preta 3°" -> 3). NULL = grau desconhecido.';
COMMENT ON FUNCTION karate_belt_kyu_from_name(text, text, text) IS
  'F8.0 regras R2+R3: kyu escrito em belt_name ("Marrom 3°kyu" -> 3) ou, na escala fpkt_shotokan, o kyu único da cor (branca=10 ... azul_escuro=4). Marrom sem grau escrito -> NULL (3 kyus na mesma cor). Escala legacy -> NULL (mapa kyu->cor desconhecido).';

-- ────────────────────────────────────────────────────────────
-- 3. Backfill — só o dedutível, contado regra a regra
--    Idempotente: só toca linhas com belt_kyu E belt_dan NULL.
-- ────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_r1 bigint := 0;
  v_r2 bigint := 0;
  v_r3 bigint := 0;
  v_null bigint := 0;
  v_total bigint := 0;
BEGIN
  -- R1: dan de "Preta N°"
  UPDATE karate_belt_history
     SET belt_dan = karate_belt_dan_from_name(belt_level, belt_name)
   WHERE belt_kyu IS NULL
     AND belt_dan IS NULL
     AND lower(belt_level) = 'preta'
     AND karate_belt_dan_from_name(belt_level, belt_name) IS NOT NULL;
  GET DIAGNOSTICS v_r1 = ROW_COUNT;

  -- R2: kyu escrito no nome ("Marrom 3°kyu")
  UPDATE karate_belt_history
     SET belt_kyu = karate_belt_kyu_from_name(belt_level, belt_name, belt_schema)
   WHERE belt_kyu IS NULL
     AND belt_dan IS NULL
     AND lower(belt_level) <> 'preta'
     AND belt_name ILIKE '%kyu%'
     AND karate_belt_degree_in_name(belt_name) IS NOT NULL;
  GET DIAGNOSTICS v_r2 = ROW_COUNT;

  -- R3: kyu deduzido da cor (fpkt_shotokan, cor de kyu único)
  UPDATE karate_belt_history
     SET belt_kyu = karate_belt_kyu_from_name(belt_level, belt_name, belt_schema)
   WHERE belt_kyu IS NULL
     AND belt_dan IS NULL
     AND belt_schema = 'fpkt_shotokan'
     AND lower(belt_level) <> 'preta'
     AND karate_belt_kyu_from_name(belt_level, belt_name, belt_schema) IS NOT NULL;
  GET DIAGNOSTICS v_r3 = ROW_COUNT;

  SELECT count(*) INTO v_total FROM karate_belt_history;
  SELECT count(*) INTO v_null  FROM karate_belt_history
   WHERE belt_kyu IS NULL AND belt_dan IS NULL;

  RAISE NOTICE 'Migration 264 backfill — R1 dan de belt_name: % | R2 kyu de belt_name: % | R3 kyu da cor (fpkt_shotokan): % | sem grau (NULL = desconhecido): % | total: %',
    v_r1, v_r2, v_r3, v_null, v_total;
  RAISE NOTICE 'Migration 264 — esperado em producao em 31/07/2026: R1=895, R2=17, R3=8614, NULL=4255, total=13781 (762 Marrom sem grau + 3493 legacy).';
END $$;

COMMENT ON COLUMN karate_belt_history.belt_kyu IS
  'F8.0: grau kyu da graduação (10 = Branca ... 1 = Marrom 1º kyu). NULL = GRAU DESCONHECIDO, nunca "sem graduação". Backfill da 264 preencheu só o dedutível: kyu escrito em belt_name (17 linhas) e kyu único da cor na escala fpkt_shotokan (8.614). As 762 linhas "Marrom" sem grau e as 3.493 da escala legacy ficaram NULL de propósito — marrom tem 3 kyus na mesma cor e o mapa kyu->cor do sistema legado é desconhecido. Mutuamente exclusivo com belt_dan.';

COMMENT ON COLUMN karate_belt_history.belt_dan IS
  'F8.0: grau dan da faixa preta (1 a 10). Só existe quando belt_level = ''preta'' (CHECK). NULL = grau desconhecido. Backfill da 264 extraiu 895 linhas do texto de belt_name ("Preta 3°" -> 3). Mutuamente exclusivo com belt_kyu. Substitui o regexp_replace sobre belt_name que a view karate_current_belt fazia desde a migration 229.';

-- ────────────────────────────────────────────────────────────
-- 4. karate_current_belt — ordem corrigida + grau nas colunas
--
--    CREATE OR REPLACE VIEW, NUNCA DROP: karate_member_standing faz
--    JOIN direto nesta view, e DROP derrubaria os GRANTs de
--    anon/authenticated/service_role (já quebramos o CI assim — ver o
--    cabeçalho da 229 e a 222). As 7 colunas originais ficam nas mesmas
--    posições e tipos; belt_kyu/belt_dan entram no FIM (é o que
--    CREATE OR REPLACE permite). karate_member_standing seleciona
--    coluna a coluna (cb.belt_level, cb.belt_name) — nada de cb.* —,
--    então nada muda para ela.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW karate_current_belt AS
SELECT DISTINCT ON (student_id, federation_id)
  student_id,
  federation_id,
  belt_level,
  belt_name,
  belt_schema,
  graduated_at AS current_since,
  exam_id,
  belt_kyu,
  belt_dan
FROM karate_belt_history
ORDER BY
  student_id,
  federation_id,
  (
    -- >>> ESCALA CANONICA — espelho de LEVEL_RANK em src/utils/karateBeltScale.js >>>
    -- Conferido por __tests__/karate.beltScale.test.js, que lê ESTE bloco.
    CASE lower(belt_level)
      WHEN 'branca' THEN 1
      WHEN 'amarela' THEN 2
      WHEN 'laranja' THEN 3
      WHEN 'verde' THEN 4
      WHEN 'azul_claro' THEN 5
      WHEN 'roxo' THEN 6
      WHEN 'roxa' THEN 6
      WHEN 'azul_escuro' THEN 7
      WHEN 'marrom' THEN 8
      WHEN 'preta' THEN 9
      WHEN 'vermelha' THEN 0
      ELSE 0
    END
    -- <<< ESCALA CANONICA <<<
  ) DESC,
  (
    -- Desempate por GRAU dentro da mesma cor. Lê a coluna nova quando
    -- existe e cai de volta para a leitura de belt_name quando é NULL —
    -- ninguém com grau desconhecido some da faixa atual.
    --   preta  → dan CRESCENTE (dan maior vence)
    --   marrom → kyu DECRESCENTE (1º kyu > 3º kyu, daí o 10 - kyu);
    --            sem grau conhecido vira 0, exatamente como na 229
    -- O terceiro braço (belt_name com "kyu" em cor que não é marrom) só
    -- existe para não perder o comportamento da 229: hoje NENHUMA linha
    -- de produção cai nele (só marrom tem "kyu" no nome).
    CASE
      WHEN lower(belt_level) = 'preta' THEN
        COALESCE(belt_dan, karate_belt_dan_from_name(belt_level, belt_name), 0)
      WHEN lower(belt_level) = 'marrom' THEN
        10 - COALESCE(belt_kyu, karate_belt_kyu_from_name(belt_level, belt_name, belt_schema), 10)
      WHEN belt_name ILIKE '%kyu%' THEN
        10 - COALESCE(karate_belt_degree_in_name(belt_name), 10)
      ELSE 0
    END
  ) DESC,
  graduated_at DESC NULLS LAST;

COMMENT ON VIEW karate_current_belt IS
  'Faixa ATUAL de cada praticante por federação. Ordem canônica FPKT (migration 264, escala confirmada em 31/07/2026): branca(1) < amarela(2) < laranja(3) < verde(4) < AZUL CLARO(5) < ROXA(6) < azul_escuro(7) < marrom(8) < preta(9); vermelha(0) fora da progressão (legada). CORRIGE a migration 229, que tinha roxo=5 e azul_claro=6 — invertidas. Desempate: cor -> grau (dan crescente / kyu decrescente) -> graduated_at DESC NULLS LAST.';

-- ────────────────────────────────────────────────────────────
-- 5. Graduação feita pelo DOJÔ (schema; a escrita é a F8.1)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS karate_dojo_belt_exams (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- O dojô que aplicou o exame (companies.id, vertical karate_dojo).
  dojo_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Federação a que o dojô é filiado no momento do exame. NULLABLE:
  -- dojô sem filiação também gradua os próprios alunos.
  federation_id  UUID REFERENCES companies(id) ON DELETE SET NULL,

  exam_date      DATE NOT NULL,
  title          TEXT,

  -- Quem examinou. TEXTO LIVRE de propósito: o examinador é o sensei
  -- (ou um convidado) e pode não ter usuário no Aura nem cadastro de
  -- praticante. Uma FK aqui obrigaria a inventar um vínculo para
  -- registrar um fato que já aconteceu. A auditoria de QUEM DIGITOU
  -- fica em created_by/created_by_name.
  examiner_name  TEXT,

  notes          TEXT,

  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'completed', 'cancelled')),

  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dojo_belt_exams_dojo
  ON karate_dojo_belt_exams (dojo_id, exam_date DESC);

CREATE INDEX IF NOT EXISTS idx_dojo_belt_exams_federation
  ON karate_dojo_belt_exams (federation_id)
  WHERE federation_id IS NOT NULL;

DO $$ BEGIN
  CREATE TRIGGER trg_dojo_belt_exams_updated_at
    BEFORE UPDATE ON karate_dojo_belt_exams
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'trg_dojo_belt_exams_updated_at já existe';
END $$;

CREATE TABLE IF NOT EXISTS karate_dojo_belt_exam_results (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  exam_id         UUID NOT NULL REFERENCES karate_dojo_belt_exams(id) ON DELETE CASCADE,

  -- Denormalizado de propósito: TODA leitura do portal do dojô é
  -- escopada por dojo_id do token, e sem esta coluna toda query
  -- precisaria de um JOIN só para descobrir o escopo.
  dojo_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- O ALUNO DO DOJÔ é a âncora — não o praticante da federação.
  -- É isto que faz "aluno não federado também é graduado" funcionar.
  student_id      UUID NOT NULL REFERENCES karate_dojo_students(id) ON DELETE CASCADE,

  -- Snapshot do vínculo federativo NO MOMENTO do exame. NULL = aluno
  -- não federado (graduação existe mesmo assim). SET NULL, nunca
  -- CASCADE: apagar o praticante na federação não pode apagar o
  -- resultado do exame do dojô (mesma regra da 262).
  practitioner_id UUID REFERENCES customers(id) ON DELETE SET NULL,

  -- Faixa de ORIGEM (descritiva; pode ser desconhecida).
  from_belt_level TEXT,
  from_belt_kyu   SMALLINT,
  from_belt_dan   SMALLINT,

  -- Faixa de DESTINO com grau.
  to_belt_level   TEXT NOT NULL,
  to_belt_name    TEXT NOT NULL,
  to_belt_kyu     SMALLINT,

  belt_schema     TEXT NOT NULL DEFAULT 'fpkt_shotokan'
                  CHECK (belt_schema IN ('legacy', 'fpkt_shotokan')),

  result          TEXT NOT NULL CHECK (result IN ('approved', 'failed')),
  notes           TEXT,

  -- Preenchido pela F8.1 quando o aluno é federado e a graduação também
  -- vira linha em karate_belt_history (source='exam_dojo'). NULL quando
  -- o aluno não é federado, quando reprovou, ou enquanto a F8.1 não roda.
  belt_history_id UUID REFERENCES karate_belt_history(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Um aluno tem um resultado por exame.
  UNIQUE (exam_id, student_id)
);

-- ── A FRONTEIRA DO SENSEI, NO SCHEMA ──────────────────────
-- O dojô gradua até o 1º kyu (Marrom 1º kyu). Faixa preta é banca da
-- federação — ver a nota "Exame estadual obrigatório com banca designada
-- pela FPKT" no degrau 1kyu → 1dan do seed da migration 150. Sem este
-- CHECK, bastaria um bug de UI para o dojô emitir uma faixa preta.
-- Pelo mesmo motivo NÃO existe coluna to_belt_dan.
DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT karate_dojo_exam_results_no_black_belt_check
    CHECK (lower(to_belt_level) <> 'preta');
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_exam_results_no_black_belt_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT karate_dojo_exam_results_to_kyu_check
    CHECK (to_belt_kyu IS NULL OR to_belt_kyu BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_exam_results_to_kyu_check já existe';
END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT karate_dojo_exam_results_from_degree_check
    CHECK ((from_belt_kyu IS NULL OR from_belt_kyu BETWEEN 1 AND 10)
       AND (from_belt_dan IS NULL OR from_belt_dan BETWEEN 1 AND 10)
       AND (from_belt_kyu IS NULL OR from_belt_dan IS NULL));
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_exam_results_from_degree_check já existe';
END $$;

-- Reprovado não gera graduação no histórico da federação.
DO $$ BEGIN
  ALTER TABLE karate_dojo_belt_exam_results
    ADD CONSTRAINT karate_dojo_exam_results_failed_has_no_history_check
    CHECK (result = 'approved' OR belt_history_id IS NULL);
EXCEPTION WHEN duplicate_object THEN
  RAISE NOTICE 'karate_dojo_exam_results_failed_has_no_history_check já existe';
END $$;

CREATE INDEX IF NOT EXISTS idx_dojo_belt_exam_results_exam
  ON karate_dojo_belt_exam_results (exam_id);

CREATE INDEX IF NOT EXISTS idx_dojo_belt_exam_results_student
  ON karate_dojo_belt_exam_results (student_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dojo_belt_exam_results_dojo
  ON karate_dojo_belt_exam_results (dojo_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dojo_belt_exam_results_practitioner
  ON karate_dojo_belt_exam_results (practitioner_id)
  WHERE practitioner_id IS NOT NULL;

COMMENT ON TABLE karate_dojo_belt_exams IS
  'F8.0: exame de faixa aplicado PELO DOJÔ (não é a banca da federação — essa é karate_belt_exams). A escrita em lote é a F8.1.';

COMMENT ON COLUMN karate_dojo_belt_exams.examiner_name IS
  'F8.0: quem examinou, em texto livre. Sem FK de propósito: o examinador pode ser um sensei convidado sem usuário no Aura e sem cadastro de praticante. Quem DIGITOU fica em created_by/created_by_name.';

COMMENT ON TABLE karate_dojo_belt_exam_results IS
  'F8.0: resultado por aluno do exame do dojô. Ancorado em karate_dojo_students (não em customers) porque ALUNO NÃO FEDERADO TAMBÉM É GRADUADO — ele não tem practitioner_id e karate_belt_history exige um praticante. Quando o aluno é federado, a F8.1 grava também a linha em karate_belt_history (source=''exam_dojo'', coluna da migration 262) e guarda o id em belt_history_id.';

COMMENT ON COLUMN karate_dojo_belt_exam_results.practitioner_id IS
  'F8.0: snapshot do vínculo federativo no momento do exame. NULL = aluno NÃO FEDERADO — a graduação do dojô existe mesmo assim.';

COMMENT ON COLUMN karate_dojo_belt_exam_results.to_belt_kyu IS
  'F8.0: grau kyu da faixa de destino (10 = Branca ... 1 = Marrom 1º kyu). NÃO existe coluna to_belt_dan: o teto do dojô é o 1º kyu e faixa preta é banca da federação (CHECK karate_dojo_exam_results_no_black_belt_check).';

COMMENT ON COLUMN karate_dojo_belt_exam_results.belt_history_id IS
  'F8.0: graduação espelhada em karate_belt_history quando o aluno é federado. NULL para aluno não federado, para reprovado, ou enquanto a F8.1 não escreve.';

-- ============================================================
-- FIM DA MIGRATION 264
-- ============================================================
