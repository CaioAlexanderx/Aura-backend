-- ============================================================
-- AURA KARATÊ — Migration 155: Extensão de transactions (federativo)
-- Adiciona federation_id + poly-ref (reference_type/reference_id) para
-- vincular lançamentos a anuidades, exames, competições, etc.
-- APLICADA em 07/06/2026 no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS federation_id UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference_type TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference_id UUID;

CREATE INDEX IF NOT EXISTS idx_transactions_federation ON transactions(federation_id);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference_type, reference_id);

-- ============================================================
-- FIM DA MIGRATION 155
-- ============================================================
