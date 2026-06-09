-- ============================================================
-- AURA KARATÊ — Migration 172: apoio ao motor de sync assíncrono (Track F)
-- A troca é por FILA: o dojô empilha eventos (webhook, status 'pending')
-- e a federação processa quando abre o sistema (catch-up por pull).
-- attempts/processed_at sustentam a re-tentativa leve e a auditoria.
-- Aplicada no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

ALTER TABLE karate_sync_events ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE karate_sync_events ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Índice parcial: achar rápido o que falta processar por federação.
CREATE INDEX IF NOT EXISTS idx_karate_sync_events_pending
  ON karate_sync_events(federation_id, created_at) WHERE status = 'pending';

-- FIM DA MIGRATION 172
