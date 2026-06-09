-- ============================================================
-- AURA KARATÊ — Migration 171: Log de sincronização/handshake (Track F)
-- karate_sync_events: trilha append-only dos eventos de sync por conexão.
-- Alimenta o painel "Status de sincronização" (DESIGN-24).
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_sync_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES karate_dojo_connections(id) ON DELETE CASCADE,
  federation_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dojo_id       UUID REFERENCES companies(id) ON DELETE SET NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('dojo_to_fed','fed_to_dojo')),
  event_type    TEXT NOT NULL CHECK (event_type IN (
                  'handshake','practitioner_added','attendance','exam_enrollment',
                  'annuity_paid','exam_result','card_issued','transfer','tournament_entry')),
  status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed','reprocessed','pending')),
  payload       JSONB,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_karate_sync_events_conn ON karate_sync_events(connection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_karate_sync_events_fed ON karate_sync_events(federation_id, status);

ALTER TABLE karate_sync_events ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 171
