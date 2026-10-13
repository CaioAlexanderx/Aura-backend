-- ============================================================
-- 378 — BIPE SINTETICO (canary_runs)
--
-- Contexto (13/10/2026): o UptimeRobot so bate em /health, que ficou verde
-- durante o incidente do pooler de 28/09 enquanto o Caixa estava fora. A
-- aposta do plano da temporada e simular o que a lojista faz — bipar um
-- produto, lancar a venda, consultar e cancelar — a cada 5 minutos, pelo
-- caminho HTTP real (jobs/canaryJob.js + services/canary.js).
--
--   canary_runs   uma linha por execucao.
--     started_at      inicio da JANELA de 5 min (truncado). O indice unico
--                     e a trava entre replicas: quem consegue inserir a
--                     linha da janela roda; as outras desistem.
--     ok              NULL enquanto roda; true/false ao terminar.
--     passos          jsonb: [{ passo, ok, ms, status, erro, detalhe }].
--     duracao_ms      soma real da execucao.
--     erro            "passo: mensagem" do primeiro passo que falhou.
--     alerta          'caiu' | 'repeticao' | 'voltou' quando esta execucao
--                     disparou e-mail. E o estado do "um aviso a cada 30
--                     min": sobrevive a deploy e vale entre instancias.
--     venda_id        a venda sintetica criada (se criou).
--     venda_pendente  true quando a venda nao foi cancelada — a proxima
--                     execucao tenta estornar antes de vender de novo.
--
-- Retencao de 30 dias: a limpeza e do proprio job (DELETE por started_at).
-- Idempotente. Tabela nova, nada existente muda.
-- ============================================================

CREATE TABLE IF NOT EXISTS canary_runs (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  ok              BOOLEAN,
  passos          JSONB NOT NULL DEFAULT '[]'::jsonb,
  duracao_ms      INTEGER,
  erro            TEXT,
  alerta          TEXT,
  venda_id        UUID,
  venda_pendente  BOOLEAN NOT NULL DEFAULT FALSE
);

-- Indice por started_at e, ao mesmo tempo, a trava da janela de 5 min.
CREATE UNIQUE INDEX IF NOT EXISTS uq_canary_runs_started_at
  ON canary_runs (started_at);

-- So as vendas que ficaram abertas (quase sempre vazio).
CREATE INDEX IF NOT EXISTS idx_canary_runs_venda_pendente
  ON canary_runs (started_at DESC) WHERE venda_pendente;
