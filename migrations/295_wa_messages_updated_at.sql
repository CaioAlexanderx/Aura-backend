-- ============================================================
-- AURA — Migration 295: wa_messages ganha updated_at
-- ------------------------------------------------------------
-- Bug (COBR A6): o webhook do WhatsApp (src/routes/webhookWhatsapp.js) faz
--   UPDATE wa_messages SET status=$1, updated_at=NOW() ...
-- mas wa_messages (src/migrations/039) só tinha created_at — sem updated_at.
-- O UPDATE estourava 42703 e era engolido pelo .catch(() => {}), então o
-- ciclo de entrega (sent → delivered → read) NUNCA foi persistido. É desse
-- status de entrega que a cobrança automática por WhatsApp vai depender.
--
-- IMPORTANTE: wa_messages é criada em src/migrations/039 — um diretório que o
-- CI (ci.yml aplica só migrations/*.sql) NÃO roda. Por isso o ALTER é guardado
-- por existência da tabela: em prod (tabela existe) adiciona a coluna; no CI /
-- ambiente sem a 039 vira NO-OP, sem quebrar o schema (ON_ERROR_STOP=1).
-- Idempotente (ADD COLUMN IF NOT EXISTS + guarda de tabela).
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'wa_messages'
  ) THEN
    ALTER TABLE wa_messages
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
END $$;

-- ============================================================
-- FIM DA MIGRATION 295
-- ============================================================
