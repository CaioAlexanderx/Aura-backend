-- ============================================================
-- AURA KARATÊ — Migration 175: Config da régua de anuidade (Track I)
-- karate_reminder_config: opt-in por federação (default OFF) + offsets dos
-- lembretes (em dias relativos ao vencimento; negativo=antes, positivo=depois).
-- A régua NÃO envia nada até a federação ligar (enabled=true).
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_reminder_config (
  federation_id UUID PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  channel       TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','whatsapp')),
  offsets_days  INTEGER[] NOT NULL DEFAULT ARRAY[-7,-1,3,15,30],
  updated_by    UUID,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE karate_reminder_config ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 175
