-- ============================================================
-- 370 — Painel da Gestao Aura (job diario + blocos + telas visitadas)
--
-- Contexto (13/10/2026): o painel interno mentia. aura_revenue_snapshot
-- tinha 1 linha (abril) e client_health_scores foi calculado pela ultima vez
-- em 25/04 — os dois dependiam de POST manual. A Gestao Aura vira uma tela
-- unica de blocos com numeros que se calculam sozinhos: um job diario
-- (06h BRT, jobs/painelDiarioScheduler.js) grava o resultado de cada bloco
-- aqui, e a API (/admin/painel) so le.
--
--   painel_runs            trava e historico do job: uma linha por dia. Quem
--                          consegue inserir a linha do dia e quem roda (pode
--                          haver mais de uma instancia na Railway).
--   painel_blocos_diarios  resultado de cada bloco no dia (jsonb). A variacao
--                          de 7/30 dias sai da comparacao com a linha do dia
--                          correspondente.
--   painel_alertas         alertas derivados no mesmo passo. `chave` existe
--                          porque pagamento sem loja nao tem company_id: e o
--                          que identifica o alerta dentro do (dia, tipo).
--   painel_layout          blocos visiveis e ordem, por usuario da equipe.
--   screen_views           telas visitadas, enviadas pelo app em lotes
--                          (POST /usage/screens). Uma linha por
--                          empresa/usuario/tela/dia.
--
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS painel_runs (
  dia          DATE PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  ok           BOOLEAN,
  erro         TEXT,
  duracao_ms   INTEGER
);

CREATE TABLE IF NOT EXISTS painel_blocos_diarios (
  dia           DATE NOT NULL,
  bloco         TEXT NOT NULL,
  dados         JSONB NOT NULL,
  calculado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (dia, bloco)
);

-- Serie historica de um bloco (variacao e graficos de tendencia).
CREATE INDEX IF NOT EXISTS idx_painel_blocos_diarios_bloco_dia
  ON painel_blocos_diarios (bloco, dia DESC);

CREATE TABLE IF NOT EXISTS painel_alertas (
  id          BIGSERIAL PRIMARY KEY,
  dia         DATE NOT NULL,
  tipo        TEXT NOT NULL,
  chave       TEXT NOT NULL,
  company_id  UUID REFERENCES companies(id) ON DELETE CASCADE,
  titulo      TEXT NOT NULL,
  detalhe     TEXT,
  verbo       TEXT,
  bloco       TEXT,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_painel_alertas_dia_tipo_chave
  ON painel_alertas (dia, tipo, chave);

CREATE INDEX IF NOT EXISTS idx_painel_alertas_company
  ON painel_alertas (company_id, dia DESC) WHERE company_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS painel_layout (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  blocos      JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS screen_views (
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  screen      VARCHAR(64) NOT NULL,
  dia         DATE NOT NULL,
  views       INTEGER NOT NULL DEFAULT 0,
  last_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, user_id, screen, dia)
);

-- O bloco "Telas visitadas" le por janela de dias, agrupando por tela.
CREATE INDEX IF NOT EXISTS idx_screen_views_dia_screen
  ON screen_views (dia, screen);

COMMENT ON TABLE painel_runs IS 'Trava e historico do job diario do painel da Gestao Aura (uma linha por dia).';
COMMENT ON TABLE painel_blocos_diarios IS 'Resultado de cada bloco do painel da Gestao Aura no dia (services/painelBlocos).';
COMMENT ON TABLE painel_alertas IS 'Alertas derivados pelo job diario do painel da Gestao Aura.';
COMMENT ON TABLE painel_layout IS 'Blocos visiveis e ordem do painel da Gestao Aura, por usuario da equipe.';
COMMENT ON TABLE screen_views IS 'Telas visitadas no app por empresa/usuario/dia (POST /usage/screens).';
