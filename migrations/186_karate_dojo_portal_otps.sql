-- migration 186: karate_dojo_portal_otps
-- Tabela de OTP para o portal do responsável do dojô (Canal B / off-app).
-- Espelha karate_portal_otps (Track D praticante) escopada a dojo_id.
-- Idempotente (IF NOT EXISTS).
--
-- Renumerada de 185 → 186: a 185 colidiu com 185_companies_name_slug.sql
-- (PR #214, destrava de prod), que já estava em main quando o branch
-- feat/karate-dojo-phase0 foi criado (17/06/2026).

CREATE TABLE IF NOT EXISTS karate_dojo_portal_otps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dojo_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL DEFAULT 'email',   -- 'email' | 'whatsapp'
  destination_hint TEXT,                          -- hint mascarado mostrado ao usuário
  code_hash     TEXT NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  max_attempts  INT NOT NULL DEFAULT 5,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kdpo_dojo_active
  ON karate_dojo_portal_otps (dojo_id, consumed_at, expires_at);
