-- ============================================================
-- 475 — alert_history: garantir que a tabela existe fora de producao
--
-- A tabela existe em producao desde antes das migrations (criada a mao), com
-- as colunas id, company_id, alert_type, severity, title, message, data,
-- is_read, created_at. Por isso nao havia migration e o banco do CI nao a
-- tinha (relation "alert_history" does not exist no teste do alerta de
-- 'sending' parada). Aqui: CREATE TABLE IF NOT EXISTS — em producao nao faz
-- nada; no CI/bancos novos cria. Sem indices (nao conferidos em producao).
--
-- Os tipos abaixo foram INFERIDOS do uso no codigo (smartAlerts.js,
-- whatsappSaldo.js, whatsappCloud.js), nao lidos de producao.
-- Aditiva e idempotente. Caminho de volta: nenhum necessario.
-- ============================================================
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS alert_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID,
  alert_type  TEXT,
  severity    TEXT,
  title       TEXT,
  message     TEXT,
  data        JSONB,
  is_read     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
