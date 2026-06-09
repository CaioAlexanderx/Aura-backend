-- ============================================================
-- AURA KARATÊ — Migration 170: Conectividade Dojô (Track F / Fase 5)
-- karate_dojo_connections: estado da conexão Federação ↔ Dojô (3 vias).
-- Numeração real: segue 169_karate_competition_entries.
--
-- Vias (plano §8):
--   native  (Via 1) — Aura Karatê Dojô, sync bidirecional em tempo real
--   adapter (Via 2) — Aura Negócio/Studio, adaptador por CPF
--   manual  (Via 3) — sem sistema, FPKT gere + sensei acesso light
--
-- SEGURANÇA: o federation_sync_token NUNCA é guardado em claro — só o
-- hash (sha256) + um prefixo curto p/ exibição mascarada.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_connections (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dojo_id             UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  via                 TEXT NOT NULL CHECK (via IN ('native','adapter','manual')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','connected','suspended','revoked','error')),
  sync_token_hash     TEXT,
  sync_token_prefix   TEXT,
  token_rotated_at    TIMESTAMPTZ,
  requested_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  connected_at        TIMESTAMPTZ,
  last_sync_at        TIMESTAMPTZ,
  last_sync_status    TEXT CHECK (last_sync_status IN ('ok','syncing','error') OR last_sync_status IS NULL),
  adapter_cpf_matched INT,
  adapter_cpf_pending INT,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (federation_id, dojo_id)
);
CREATE INDEX IF NOT EXISTS idx_karate_conn_federation ON karate_dojo_connections(federation_id, status);
CREATE INDEX IF NOT EXISTS idx_karate_conn_dojo ON karate_dojo_connections(dojo_id);

DROP TRIGGER IF EXISTS trg_karate_conn_updated_at ON karate_dojo_connections;
CREATE TRIGGER trg_karate_conn_updated_at BEFORE UPDATE ON karate_dojo_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_dojo_connections ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 170
