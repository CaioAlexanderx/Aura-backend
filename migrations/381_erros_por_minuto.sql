-- ============================================================
-- 381 — ERRO NA PONTA DO LOJISTA, POR MINUTO (erros_por_minuto)
--
-- Contexto (14/10/2026, card t1-02): o log da Railway lido cobre so 7 dias e
-- mostrou 253 linhas EMAXCONNSESSION e 181 requisicoes de lojista rejeitadas
-- em requireCompanyAccess. Sem uma serie, ninguem sabe se o pooler satura
-- todo dia ou so em rajada. Cada instancia do backend conta em memoria
-- (services/errosPorMinuto.js) e grava UMA linha por minuto fechado:
--
--   minuto           inicio do minuto (timestamptz, truncado).
--   instancia        quem gravou (replica da Railway). O mesmo minuto vem de
--                    varias instancias; o painel soma por minuto.
--   requisicoes      respostas enviadas (sem OPTIONS nem /health).
--   erros_5xx        respostas com status >= 500.
--   emaxconnsession  erros do pooler (EMAXCONNSESSION / max clients reached)
--                    vistos numa consulta ou conexao do pool.
--
-- Chave (minuto, instancia): regravar o mesmo minuto da mesma instancia (um
-- restart no meio do minuto) SOMA ao que ja esta la (ON CONFLICT no codigo).
-- A chave tambem serve a leitura por faixa de minutos do bloco Plataforma.
--
-- Retencao de 7 dias: a limpeza e do proprio job (DELETE por minuto, no
-- maximo uma vez por hora). Tabela pequena: ~1.440 linhas por dia e instancia.
-- Idempotente. Tabela nova, nada existente muda; o runtime guarda 42P01 ate
-- a migration subir.
-- ============================================================

CREATE TABLE IF NOT EXISTS erros_por_minuto (
  minuto           TIMESTAMPTZ NOT NULL,
  instancia        TEXT        NOT NULL,
  requisicoes      INTEGER     NOT NULL DEFAULT 0,
  erros_5xx        INTEGER     NOT NULL DEFAULT 0,
  emaxconnsession  INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (minuto, instancia)
);
