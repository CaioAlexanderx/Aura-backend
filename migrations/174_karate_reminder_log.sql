-- ============================================================
-- AURA KARATÊ — Migration 174: Log de lembretes de anuidade (Track I)
-- karate_reminder_log: trilha append-only dos lembretes enviados pela régua.
-- Também é o LOCK DE IDEMPOTÊNCIA: o índice único parcial garante 1 lembrete
-- por (anuidade, regra, canal) bem-sucedido — múltiplas réplicas/ticks não
-- reenviam o mesmo estágio.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_reminder_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- alvo: anuidade de dojô (karate_dojo_annuity_history.id). Sem FK rígida para
  -- permitir futura extensão a anuidade CPF (transactions) sem nova migration.
  annuity_id    UUID NOT NULL,
  dojo_id       UUID REFERENCES companies(id) ON DELETE SET NULL,
  channel       TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp')),
  recipient     TEXT,
  rule_code     TEXT NOT NULL,            -- due_minus_7, due_minus_1, overdue_3, ...
  status        TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  provider_id   TEXT,                     -- id retornado pelo Resend
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotência: 1 envio bem-sucedido por (anuidade, regra, canal). Falhas não
-- bloqueiam reenvio (WHERE status='sent').
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_reminder_once
  ON karate_reminder_log(annuity_id, rule_code, channel)
  WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_karate_reminder_log_fed
  ON karate_reminder_log(federation_id, created_at DESC);

ALTER TABLE karate_reminder_log ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 174
