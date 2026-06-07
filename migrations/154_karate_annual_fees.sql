-- ============================================================
-- AURA KARATÊ — Migration 154: Tabela de anuidades
-- Anuidades por porte (dojô) e individual (CPF), por federação,
-- com histórico de reajuste (várias linhas; vigente = maior effective_from).
-- APLICADA em 07/06/2026 no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_annual_fees (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  federation_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fee_type       TEXT NOT NULL DEFAULT 'dojo' CHECK (fee_type IN ('dojo','cpf')),
  size_tier      TEXT CHECK (size_tier IN ('up_to_40','41_90','91_150','over_150')),
  amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- dojô exige porte; cpf não tem porte
  CONSTRAINT chk_fee_tier CHECK (
    (fee_type = 'dojo' AND size_tier IS NOT NULL) OR
    (fee_type = 'cpf'  AND size_tier IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_karate_fees_lookup
  ON karate_annual_fees(federation_id, fee_type, size_tier, effective_from DESC);

ALTER TABLE karate_annual_fees ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- FIM DA MIGRATION 154
-- ============================================================
