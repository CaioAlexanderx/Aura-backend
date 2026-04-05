-- ============================================================
-- AURA. Migration 031 — MKT-01: Bank Reconciliation
-- Conciliacao bancaria: contas, extratos, matches
-- ============================================================

-- Contas bancarias do cliente
CREATE TABLE IF NOT EXISTS bank_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_name     VARCHAR(100) NOT NULL,
  bank_code     VARCHAR(10),
  agency        VARCHAR(20),
  account_number VARCHAR(30),
  account_type  VARCHAR(20) DEFAULT 'corrente',
  nickname      VARCHAR(100),
  initial_balance NUMERIC(14,2) DEFAULT 0,
  current_balance NUMERIC(14,2) DEFAULT 0,
  is_primary    BOOLEAN DEFAULT false,
  is_active     BOOLEAN DEFAULT true,
  last_import   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts ON bank_accounts(company_id, is_active);

COMMENT ON COLUMN bank_accounts.account_type IS 'corrente, poupanca, pagamento';

-- Entradas do extrato bancario (importadas via OFX/CSV)
CREATE TABLE IF NOT EXISTS bank_statement_entries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  description   TEXT NOT NULL,
  amount        NUMERIC(14,2) NOT NULL,
  balance       NUMERIC(14,2),
  reference     VARCHAR(100),
  category      VARCHAR(50),
  fitid         VARCHAR(100),
  import_batch  VARCHAR(50),
  match_status  VARCHAR(20) DEFAULT 'pendente',
  matched_transaction_id UUID REFERENCES transactions(id),
  matched_at    TIMESTAMPTZ,
  matched_by    VARCHAR(20),
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_entries_account ON bank_statement_entries(bank_account_id, date);
CREATE INDEX IF NOT EXISTS idx_bank_entries_match ON bank_statement_entries(company_id, match_status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_entries_fitid ON bank_statement_entries(bank_account_id, fitid) WHERE fitid IS NOT NULL;

COMMENT ON COLUMN bank_statement_entries.match_status IS 'pendente, automatico, manual, ignorado, divergente';
COMMENT ON COLUMN bank_statement_entries.matched_by IS 'auto, manual';
COMMENT ON COLUMN bank_statement_entries.fitid IS 'Financial Institution Transaction ID from OFX (prevents duplicates)';

-- Regras de conciliacao automatica
CREATE TABLE IF NOT EXISTS bank_reconciliation_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  match_field   VARCHAR(20) NOT NULL DEFAULT 'description',
  match_pattern VARCHAR(200) NOT NULL,
  match_type    VARCHAR(20) DEFAULT 'contains',
  target_category VARCHAR(50),
  auto_match    BOOLEAN DEFAULT true,
  is_active     BOOLEAN DEFAULT true,
  matches_count INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_rules ON bank_reconciliation_rules(company_id, is_active);

COMMENT ON COLUMN bank_reconciliation_rules.match_type IS 'contains, starts_with, exact, regex';
