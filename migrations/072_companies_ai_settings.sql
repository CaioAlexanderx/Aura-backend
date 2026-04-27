-- ============================================================
-- AURA. — IA Modo Consulta: settings por empresa
-- Data: 2026-04-27 (PR18)
--
-- Adiciona colunas em companies para controle granular da IA:
--   - ai_enabled: opt-in explicito (default false mesmo no Expansao)
--   - ai_consent_at: timestamp do aceite do termo LGPD
--   - ai_consent_version: qual versao do termo aceitou (pra auditoria)
--   - ai_monthly_quota: cap mensal de chamadas (Expansao=500, Personalizado=null=ilimitado)
--
-- Por que opt-in mesmo com plano: dado clinico do paciente vai
-- pra LLM externa. Decisao consciente do dentista, nao automatica.
--
-- Idempotente. Aplicada em prod via MCP Supabase em 2026-04-27.
-- ============================================================

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS ai_enabled         BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_consent_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_consent_version VARCHAR(10),
  ADD COLUMN IF NOT EXISTS ai_monthly_quota   INT;

COMMENT ON COLUMN companies.ai_enabled         IS 'Opt-in explicito da IA. False mesmo no Expansao ate o dentista ativar nas configuracoes.';
COMMENT ON COLUMN companies.ai_consent_at      IS 'Timestamp do aceite do termo LGPD pra envio de dados clinicos a LLM externa.';
COMMENT ON COLUMN companies.ai_consent_version IS 'Versao do termo aceito (ex: v1.0). Permite forcar re-aceite quando termo muda.';
COMMENT ON COLUMN companies.ai_monthly_quota   IS 'Cap mensal de chamadas LLM. NULL=ilimitado (Personalizado). Default por plano: Expansao=500.';

-- Default quota por plano (so pra registros existentes; novos precisam decidir explicitamente)
UPDATE companies SET ai_monthly_quota = 500 WHERE plan = 'expansao' AND ai_monthly_quota IS NULL;
