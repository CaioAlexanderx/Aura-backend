-- ============================================================
-- AURA — Migration 295: wa_messages ganha updated_at
-- ------------------------------------------------------------
-- Bug (COBR A6): o webhook do WhatsApp (src/routes/webhookWhatsapp.js) faz
--   UPDATE wa_messages SET status=$1, updated_at=NOW() ...
-- mas wa_messages (src/migrations/039) só tem created_at — sem updated_at.
-- O UPDATE estourava 42703 e era engolido pelo .catch(() => {}), então o
-- ciclo de entrega (sent → delivered → read) NUNCA foi persistido. É desse
-- status de entrega que a cobrança automática por WhatsApp vai depender.
--
-- Idempotente (ADD COLUMN IF NOT EXISTS).
-- ============================================================

ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================
-- FIM DA MIGRATION 295
-- ============================================================
