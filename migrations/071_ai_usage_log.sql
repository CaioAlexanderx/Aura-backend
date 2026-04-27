-- ============================================================
-- AURA. — IA Modo Consulta: cost tracking
-- Data: 2026-04-27 (PR18 — Configurar IA Claude para Aura)
--
-- Tabela de log para todas as chamadas LLM do feature
-- "IA Aura no Modo Consulta" (POST /companies/:cid/dental/ai/consulta).
--
-- Guarda apenas METADATA (tokens/custo/latencia/intent), NUNCA
-- o conteudo das mensagens. Conteudo bruto da consulta nao e
-- persistido em log nosso (LGPD: dado clinico do paciente nao
-- vai pra log de operacao).
--
-- Resposta da IA, quando salva, vai pra evolucao clinica
-- (dental_appointments.clinical_notes) atraves do fluxo normal
-- do dentista no ConsultaEndModal.
--
-- Idempotente conforme regra do projeto (CREATE TABLE IF NOT EXISTS).
-- Aplicada em producao via MCP Supabase em 2026-04-27.
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_usage_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  appointment_id  UUID,                    -- referencia solta (pode ser cancelada/deletada sem afetar log)
  feature         VARCHAR(40) NOT NULL,    -- 'consulta' (futuro: 'chat','insights','etc')
  intent          VARCHAR(40) NOT NULL,    -- 'brief' | 'suggestion' | 'qa' | 'summarize' | 'prescribe'
  model           VARCHAR(60) NOT NULL,    -- 'claude-haiku-4-5-20251001' etc
  tokens_in       INT NOT NULL DEFAULT 0,
  tokens_out      INT NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  latency_ms      INT NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'ok',  -- 'ok' | 'error' | 'rate_limited' | 'timeout'
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_company_created
  ON ai_usage_log (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_company_month
  ON ai_usage_log (company_id, date_trunc('month', created_at));

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_feature
  ON ai_usage_log (feature, intent);

COMMENT ON TABLE  ai_usage_log    IS 'Log de chamadas LLM (cost tracking). Sem conteudo das mensagens — so metadata.';
COMMENT ON COLUMN ai_usage_log.feature IS 'Feature que disparou a chamada (ex: consulta = Modo Consulta dental)';
COMMENT ON COLUMN ai_usage_log.intent  IS 'Sub-acao dentro da feature (ex: brief, summarize, qa)';
COMMENT ON COLUMN ai_usage_log.cost_usd IS 'Custo USD calculado: (tokens_in * price_in_per_token) + (tokens_out * price_out_per_token)';
