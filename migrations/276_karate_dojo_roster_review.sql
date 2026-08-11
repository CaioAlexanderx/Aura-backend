-- ============================================================
-- AURA DOJÔ — F11.3: REVISÃO DO PLANTEL HERDADO
-- (migration 276 — NÃO aplicada neste PR)
--
-- ── O PROBLEMA ──────────────────────────────────────────────
-- A F11.0–F11.2 fez a conta do sensei PASSAR A SER o registro federativo
-- que a FPKT já tinha (ver migration 275). Ele herda, no mesmo ato, os
-- praticantes que já apontavam para aquela linha — e a lista da federação
-- está velha: 9.840 praticantes em 105 registros, e 74 dojôs marcados como
-- INATIVOS ainda carregam 4.033 deles. Gente que parou de treinar há anos e
-- nunca foi baixada.
--
-- Decisão do dono do produto (10/08/2026): ao assumir o registro, o sensei
-- REVISA o plantel herdado e marca quem realmente treina com ele. Quem ele
-- não reconhece volta para a federação COMO AVISO.
--
-- ── A REGRA QUE ESTE SCHEMA EXISTE PARA PROTEGER ────────────
-- "NÃO RECONHECIDO" NÃO É SINÔNIMO DE "INATIVO".
--
-- O praticante pode ter MUDADO DE DOJÔ — karate_practitioner_transfers tem
-- 540 linhas, o modelo já prevê isso desde a migration 180. O sensei sabe
-- responder "esta pessoa treina comigo?"; ele NÃO sabe responder "esta
-- pessoa parou de treinar karatê?". São perguntas diferentes, e só a
-- primeira é dele.
--
-- Por isso o aviso é um FATO, não um comando:
--   * `karate_dojo_roster_review_notices` registra "o sensei do dojô X não
--     reconhece este praticante como aluno atual, em tal data";
--   * NENHUM gatilho, NENHUMA trigger e NENHUMA rota deste PR inativa
--     ninguém a partir dessa marcação;
--   * a coluna `decision` guarda o que a FEDERAÇÃO decidiu depois —
--     'inactivated' | 'transferred' | 'kept' — e nasce em 'pending'.
--
-- Inativar 4.033 pessoas por inferência automática seria dano difícil de
-- desfazer: o histórico de faixa, carteirinha, anuidade e competição de
-- cada uma delas fica pendurado no status. O caminho honesto é caro em
-- clique e barato em arrependimento.
--
-- ── AS TRÊS TABELAS E POR QUÊ ───────────────────────────────
-- 1) karate_dojo_roster_reviews  — a SESSÃO de revisão (o cabeçalho).
--    Existe porque a revisão é RETOMÁVEL (o sensei marca metade hoje e
--    termina amanhã) e porque "quando o dojô concluiu, e com que números"
--    é a pergunta que a federação vai fazer. Índice único PARCIAL em
--    (dojo_id) WHERE status='in_progress': no máximo UMA revisão aberta
--    por dojô, e nada impede uma SEGUNDA rodada depois de concluída a
--    primeira (o plantel muda; a revisão não é evento único da vida).
--
-- 2) karate_dojo_roster_review_items — o estado POR PRATICANTE.
--    LINHA SÓ PARA QUEM FOI TOCADO. Não pré-populamos 9.840 linhas: a
--    ausência de linha É o estado "ainda não revisado", e a listagem sai
--    de um LEFT JOIN com `customers`. Isso torna a migration barata, a
--    revisão retomável de graça e a marcação em lote um único INSERT com
--    unnest(). UNIQUE (review_id, practitioner_id) é a idempotência: a
--    mesma marcação reenviada faz DO UPDATE do status, nunca uma 2ª linha.
--
-- 3) karate_dojo_roster_review_notices — o AVISO à federação.
--    Separado dos itens de propósito: `items` é rascunho do sensei e muda
--    o tempo todo até ele concluir; `notices` é o que foi COMUNICADO, e
--    só nasce no ato de concluir. Guarda um SNAPSHOT do nome/matrícula/
--    status do praticante no momento do aviso — para a fila da federação
--    continuar legível mesmo depois de a pessoa ser transferida,
--    renomeada ou removida. UNIQUE (review_id, practitioner_id): concluir
--    duas vezes não duplica aviso.
--
-- ── SEM FOREIGN KEY, PELO MESMO MOTIVO DA 275 ───────────────
-- Trilha não pode ser apagada em cascata pelo objeto que ela audita. Um
-- aviso que some junto com a company do dojô, ou com a linha de
-- `customers` que ele descreve, é exatamente o oposto do que a tabela
-- existe para fazer — e é por isso que o snapshot de nome/matrícula vive
-- na própria linha do aviso.
--
-- Idempotente / aditiva: CREATE TABLE/INDEX IF NOT EXISTS, sem DDL
-- destrutivo, sem tocar em nenhuma tabela existente. Padrão das
-- 275/274/272/263.
-- ============================================================

-- ── 1) A SESSÃO DE REVISÃO ──────────────────────────────────
CREATE TABLE IF NOT EXISTS karate_dojo_roster_reviews (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- O dojô é SEMPRE a company do REGISTRO federativo (o que o sensei
  -- assumiu). Vem do token em toda rota do lado do dojô, nunca do corpo.
  dojo_id              uuid NOT NULL,
  federation_id        uuid,
  -- Qual assunção de registro originou esta revisão
  -- (karate_dojo_registry_assumptions.id, migration 275). NULLABLE e
  -- best-effort: a revisão do plantel é útil também para um dojô que
  -- nunca passou por assunção (a federação criou o dojô e o sensei
  -- reivindicou a conta pelo claim-invite da F0).
  assumption_id        uuid,
  status               text NOT NULL DEFAULT 'in_progress'
                       CHECK (status IN ('in_progress', 'completed')),
  started_by           uuid,
  started_by_label     text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  completed_by         uuid,
  completed_by_label   text,
  completed_at         timestamptz,
  -- Snapshot dos números no ato de concluir (a lista viva muda depois).
  inherited_total      integer,
  recognized_count     integer,
  not_recognized_count integer,
  notices_created      integer,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- No máximo UMA revisão aberta por dojô. Parcial de propósito: concluída
-- a primeira, uma segunda rodada pode ser aberta depois sem esbarrar aqui.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kdrr_one_open_per_dojo
  ON karate_dojo_roster_reviews (dojo_id)
  WHERE status = 'in_progress';

CREATE INDEX IF NOT EXISTS idx_kdrr_dojo_started
  ON karate_dojo_roster_reviews (dojo_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_kdrr_federation_status
  ON karate_dojo_roster_reviews (federation_id, status, completed_at DESC);

COMMENT ON TABLE karate_dojo_roster_reviews IS
  'F11.3 Aura Dojô: sessão de revisão do plantel herdado do registro federativo. Retomável (marca metade hoje, termina amanhã) e com no máximo uma aberta por dojô (índice único parcial). Concluir NÃO inativa ninguém — gera avisos em karate_dojo_roster_review_notices.';

-- ── 2) O ESTADO POR PRATICANTE (rascunho do sensei) ──────────
CREATE TABLE IF NOT EXISTS karate_dojo_roster_review_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id         uuid NOT NULL,
  -- Denormalizado de propósito: toda escrita do lado do dojô é escopada
  -- pelo dojo_id do TOKEN, e isso permite conferir o escopo sem JOIN.
  dojo_id           uuid NOT NULL,
  -- customers.id (o praticante da FEDERAÇÃO), nunca karate_dojo_students.
  practitioner_id   uuid NOT NULL,
  status            text NOT NULL
                    CHECK (status IN ('recognized', 'not_recognized')),
  reviewed_by       uuid,
  reviewed_by_label text,
  reviewed_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- IDEMPOTÊNCIA DA MARCAÇÃO: reenviar a mesma marcação faz DO UPDATE do
-- status, nunca uma segunda linha. É o que permite ao front mandar o lote
-- inteiro de novo depois de uma queda de rede sem sujar nada.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kdrri_review_practitioner
  ON karate_dojo_roster_review_items (review_id, practitioner_id);

CREATE INDEX IF NOT EXISTS idx_kdrri_review_status
  ON karate_dojo_roster_review_items (review_id, status);

CREATE INDEX IF NOT EXISTS idx_kdrri_dojo_practitioner
  ON karate_dojo_roster_review_items (dojo_id, practitioner_id);

COMMENT ON TABLE karate_dojo_roster_review_items IS
  'F11.3: marcação do sensei por praticante herdado. LINHA SÓ PARA QUEM FOI TOCADO — a AUSÊNCIA de linha é o estado "ainda não revisado" (a listagem sai de LEFT JOIN com customers). Evita pré-popular 9.840 linhas e torna a revisão retomável de graça.';

COMMENT ON COLUMN karate_dojo_roster_review_items.status IS
  'recognized = o sensei confirma que esta pessoa treina no dojô hoje. not_recognized = ele NÃO a reconhece como aluna atual. ⚠️ not_recognized NÃO significa inativo: a pessoa pode ter mudado de dojô (karate_practitioner_transfers). Quem decide o que fazer é a federação, em karate_dojo_roster_review_notices.decision.';

-- ── 3) O AVISO À FEDERAÇÃO (o que foi comunicado) ────────────
CREATE TABLE IF NOT EXISTS karate_dojo_roster_review_notices (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id                uuid NOT NULL,
  dojo_id                  uuid NOT NULL,
  federation_id            uuid,
  practitioner_id          uuid NOT NULL,
  -- SNAPSHOT no momento do aviso: a fila da federação continua legível
  -- mesmo se a pessoa for transferida, renomeada ou removida depois.
  practitioner_name        text,
  practitioner_fpkt_number text,
  practitioner_was_active  boolean,
  -- O FATO comunicado, em texto estável. Um só valor hoje; a coluna existe
  -- para o dia em que houver um segundo motivo (ex.: 'duplicado').
  reason                   text NOT NULL DEFAULT 'nao_reconhecido_pelo_sensei',
  reported_by              uuid,
  reported_by_label        text,
  reported_at              timestamptz NOT NULL DEFAULT now(),
  -- ⚠️ O QUE A FEDERAÇÃO DECIDIU. Nasce 'pending' e SÓ muda por ato
  -- humano na rota da federação. Nenhum caminho automático escreve aqui.
  decision                 text NOT NULL DEFAULT 'pending'
                           CHECK (decision IN ('pending', 'inactivated', 'transferred', 'kept')),
  decision_note            text,
  -- Preenchido só quando decision='transferred'.
  destination_dojo_id      uuid,
  decided_by               uuid,
  decided_by_label         text,
  decided_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- IDEMPOTÊNCIA DO AVISO: concluir a revisão duas vezes não duplica nada
-- (o INSERT usa ON CONFLICT (review_id, practitioner_id) DO NOTHING).
-- Chaveado por REVIEW, não por dojô: uma segunda rodada de revisão, meses
-- depois, pode legitimamente avisar de novo sobre a mesma pessoa — é um
-- fato novo, com data nova.
CREATE UNIQUE INDEX IF NOT EXISTS uq_kdrrn_review_practitioner
  ON karate_dojo_roster_review_notices (review_id, practitioner_id);

-- "O que ainda está na minha fila?" — a pergunta da federação.
CREATE INDEX IF NOT EXISTS idx_kdrrn_federation_decision
  ON karate_dojo_roster_review_notices (federation_id, decision, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_kdrrn_dojo
  ON karate_dojo_roster_review_notices (dojo_id, reported_at DESC);

-- "Alguém já avisou algo sobre esta pessoa?" — a pergunta inversa.
CREATE INDEX IF NOT EXISTS idx_kdrrn_practitioner
  ON karate_dojo_roster_review_notices (practitioner_id, reported_at DESC);

COMMENT ON TABLE karate_dojo_roster_review_notices IS
  'F11.3: aviso do dojô à federação — "o sensei não reconhece este praticante como aluno atual". É um FATO, não um comando: NÃO inativa ninguém. A federação decide depois (decision: inactivated | transferred | kept), porque a pessoa pode ter apenas MUDADO DE DOJÔ (karate_practitioner_transfers). SEM FK de propósito: aviso não some em cascata com o que descreve — daí o snapshot de nome/matrícula na própria linha.';

COMMENT ON COLUMN karate_dojo_roster_review_notices.decision IS
  'pending = a federação ainda não olhou. inactivated = ela inativou o praticante (customers.is_active=false). transferred = ela o moveu para outro dojô (destination_dojo_id + linha em karate_practitioner_transfers). kept = ela conferiu e manteve como está. NUNCA é escrita por gatilho: só pela rota POST /federation/:id/roster-review-notices/:noticeId/decision, com ator identificado.';

COMMENT ON COLUMN karate_dojo_roster_review_notices.practitioner_was_active IS
  'customers.is_active no instante do aviso. Sinal útil para a federação priorizar a fila: um praticante que ela já tinha como INATIVO e que o sensei também não reconhece é decisão fácil; um ATIVO não reconhecido é o caso que merece olhar (pode ser transferência não registrada).';
