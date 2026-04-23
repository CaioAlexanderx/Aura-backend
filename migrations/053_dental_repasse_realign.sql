-- ============================================================
-- AURA. — Migration 053: ODT-05 Repasse realinhado a dental_practitioners
--
-- Contexto: dental_repasse_ledger.practitioner_id apontava pra employees
-- (legado pre-dental_practitioners). dental_practitioners nao tinha
-- repasse_pct. Corrige ambos.
-- Zero dados em producao (validado antes).
-- Aplicada em producao via MCP Supabase em 23/04/2026.
-- ============================================================

ALTER TABLE dental_practitioners
  ADD COLUMN IF NOT EXISTS repasse_pct NUMERIC(5,2) NOT NULL DEFAULT 50.00
    CHECK (repasse_pct >= 0 AND repasse_pct <= 100);

ALTER TABLE dental_repasse_ledger
  DROP CONSTRAINT IF EXISTS dental_repasse_ledger_practitioner_id_fkey;

ALTER TABLE dental_repasse_ledger
  ADD CONSTRAINT dental_repasse_ledger_practitioner_id_fkey
  FOREIGN KEY (practitioner_id)
  REFERENCES dental_practitioners(id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_repasse_ledger_practitioner
  ON dental_repasse_ledger(practitioner_id);
CREATE INDEX IF NOT EXISTS idx_repasse_ledger_month
  ON dental_repasse_ledger(company_id, reference_month);
