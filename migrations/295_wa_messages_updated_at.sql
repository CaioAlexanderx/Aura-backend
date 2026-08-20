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
-- Idempotente (ADD COLUMN IF NOT EXISTS) e defensiva (IF EXISTS): a tabela
-- wa_messages nasce em src/migrations/039 — o diretório LEGADO, que o CI
-- não aplica (o passo "Apply test schema" só roda migrations/*.sql). Sem o
-- IF EXISTS, esta migration derrubava o CI de TODO PR novo com
-- `relation "wa_messages" does not exist`. Em produção a tabela existe e o
-- ALTER roda normalmente; no CI vira no-op.
-- ============================================================

ALTER TABLE IF EXISTS wa_messages
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- ============================================================
-- FIM DA MIGRATION 295
-- ============================================================
