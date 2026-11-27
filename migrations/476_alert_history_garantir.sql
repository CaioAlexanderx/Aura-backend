-- ============================================================
-- 476 — alert_history: garantir que a tabela existe fora de producao
--
-- A tabela existe em producao desde antes das migrations (criada a mao), por
-- isso o banco do CI nao a tinha (relation "alert_history" does not exist no
-- teste do alerta de 'sending' parada). CREATE TABLE IF NOT EXISTS: em
-- producao nao faz nada; no CI/bancos novos cria. Formato e indices
-- conferidos em producao (so SELECT); uuid_generate_v4() vem do uuid-ossp,
-- criado na 001. Aditiva e idempotente; sem caminho de volta necessario.
-- ============================================================
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS alert_history (
  id          UUID        NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
  company_id  UUID        NOT NULL REFERENCES companies(id),
  alert_type  TEXT        NOT NULL,
  severity    TEXT        NOT NULL DEFAULT 'info',
  title       TEXT        NOT NULL,
  message     TEXT        NOT NULL,
  data        JSONB                DEFAULT '{}'::jsonb,
  is_read     BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_history_company ON alert_history (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_unread ON alert_history (company_id, is_read) WHERE is_read = false;
