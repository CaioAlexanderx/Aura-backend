-- ============================================================
-- AURA. — Migration 175: contingência offline (S3.1) + motor tributário (S3.2)
--
-- 1. nfce_pending_transmission: fila de retransmissão das notas emitidas
--    em contingência (tpEmis=9). Prazo legal de transmissão controlado
--    por deadline_at (default 24h — NT de contingência NFC-e).
-- 2. products.tax_profile: perfil tributário por produto (Simples):
--    simples_padrao→CSOSN 102 · simples_isento_faixa→103 ·
--    simples_st→500 · simples_outros→900. NULL = simples_padrao.
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS nfce_pending_transmission (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  emission_id     UUID NOT NULL UNIQUE REFERENCES nfce_emissions(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  attempts        SMALLINT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_error      TEXT,
  deadline_at     TIMESTAMPTZ NOT NULL,
  transmitted_at  TIMESTAMPTZ,
  queued_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE nfce_pending_transmission IS 'Fila de retransmissão de NFC-e emitidas em contingência offline (tpEmis=9) — S3.1';
COMMENT ON COLUMN nfce_pending_transmission.status IS 'pending | transmitted (autorizada) | rejected (rejeitada-tardia: alerta+regularização) | expired (estourou prazo legal) | failed';
COMMENT ON COLUMN nfce_pending_transmission.deadline_at IS 'Prazo legal de transmissão (24h por default — NFCE_CONTINGENCY_DEADLINE_H)';

CREATE INDEX IF NOT EXISTS idx_nfce_pending_tx_queue
  ON nfce_pending_transmission(status, queued_at)
  WHERE status = 'pending';

DO $$ BEGIN
  ALTER TABLE nfce_pending_transmission
    ADD CONSTRAINT chk_nfce_pending_tx_status
    CHECK (status IN ('pending','transmitted','rejected','expired','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===== S3.2: perfil tributário por produto =====

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS tax_profile VARCHAR(30);

DO $$ BEGIN
  ALTER TABLE products
    ADD CONSTRAINT chk_products_tax_profile
    CHECK (tax_profile IS NULL OR tax_profile IN
      ('simples_padrao','simples_isento_faixa','simples_st','simples_outros'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN products.tax_profile IS 'Perfil tributário (Simples): simples_padrao=CSOSN 102 · simples_isento_faixa=103 · simples_st=500 (ICMS retido) · simples_outros=900. NULL = simples_padrao. Definir com o contador — S3.2';
