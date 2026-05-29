-- credit_unify_schema
-- Cria as tabelas do modulo de crediario (IF NOT EXISTS) e adiciona as novas
-- colunas do modelo de cobertura FIFO (creditLedger.js).
--
-- Idempotente: todas as operacoes DDL usam IF NOT EXISTS.
-- As tabelas podem ja existir em producao (foram criadas diretamente);
-- em DB limpo (CI) precisam ser criadas aqui pois nao ha migration numerada para elas.
-- 29/05/2026

-- ─── 1. customer_credit_profiles (score + limite) ─────────────────────────
CREATE TABLE IF NOT EXISTS customer_credit_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  credit_limit        NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit_used         NUMERIC(12,2) NOT NULL DEFAULT 0,
  credit_score        INTEGER        NOT NULL DEFAULT 500,
  status              VARCHAR(20)    NOT NULL DEFAULT 'active',
  blocked_reason      TEXT,
  total_paid_count    INTEGER        NOT NULL DEFAULT 0,
  total_paid_on_time  INTEGER        NOT NULL DEFAULT 0,
  avg_days_late       NUMERIC(6,2)   NOT NULL DEFAULT 0,
  total_purchases     NUMERIC(12,2)  NOT NULL DEFAULT 0,
  relationship_months INTEGER        NOT NULL DEFAULT 0,
  score_updated_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ccp_company_customer UNIQUE (company_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_ccp_company ON customer_credit_profiles (company_id);
CREATE INDEX IF NOT EXISTS idx_ccp_score   ON customer_credit_profiles (company_id, credit_score DESC);

-- ─── 2. credit_plan_configs (parametros de parcelamento) ──────────────────
CREATE TABLE IF NOT EXISTS credit_plan_configs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  max_installments      INTEGER        NOT NULL DEFAULT 12,
  min_installment_value NUMERIC(12,2)  NOT NULL DEFAULT 50,
  interest_rate         NUMERIC(6,4)   NOT NULL DEFAULT 0,
  late_fee_rate         NUMERIC(6,4)   NOT NULL DEFAULT 2,
  late_interest_daily   NUMERIC(8,4)   NOT NULL DEFAULT 0.0333,
  require_score_min     INTEGER        NOT NULL DEFAULT 300,
  auto_block_days       INTEGER        NOT NULL DEFAULT 30,
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_cpc_company UNIQUE (company_id)
);

-- ─── 3. credit_installments (agenda de vencimentos) ───────────────────────
CREATE TABLE IF NOT EXISTS credit_installments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id             UUID            NOT NULL,
  customer_id         UUID            NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  installment_number  INTEGER         NOT NULL,
  total_installments  INTEGER         NOT NULL,
  amount_due          NUMERIC(12,2)   NOT NULL,
  amount_paid         NUMERIC(12,2)   NOT NULL DEFAULT 0,
  covered_amount      NUMERIC(12,2)   NOT NULL DEFAULT 0,
  due_date            DATE            NOT NULL,
  paid_at             TIMESTAMPTZ,
  status              VARCHAR(20)     NOT NULL DEFAULT 'pending',
  pix_link            TEXT,
  pix_expires_at      TIMESTAMPTZ,
  late_fee            NUMERIC(12,2)   NOT NULL DEFAULT 0,
  late_interest       NUMERIC(12,2)   NOT NULL DEFAULT 0,
  collection_stage    INTEGER         NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ci_sale     ON credit_installments (sale_id);
CREATE INDEX IF NOT EXISTS idx_ci_customer ON credit_installments (company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_ci_status   ON credit_installments (company_id, status);

-- ─── 4. credit_collection_rules (regua de cobranca) ───────────────────────
CREATE TABLE IF NOT EXISTS credit_collection_rules (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  whatsapp_connected  BOOLEAN NOT NULL DEFAULT false,
  rules               JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ccr_company UNIQUE (company_id)
);

-- ─── 5. credit_collection_events (historico de cobranças) ─────────────────
CREATE TABLE IF NOT EXISTS credit_collection_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installment_id  UUID NOT NULL REFERENCES credit_installments(id) ON DELETE CASCADE,
  channel         VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  template        VARCHAR(50),
  days_relative   INTEGER,
  status          VARCHAR(20) NOT NULL DEFAULT 'sent',
  message_preview TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cce_installment ON credit_collection_events (installment_id);

-- ─── 6. customer_credit_transactions — adiciona idempotency_key ───────────
-- A tabela ja e criada por 099_customer_credit.sql; apenas adicionamos a coluna.
ALTER TABLE customer_credit_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cct_idempotency_key
  ON customer_credit_transactions (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ─── 7. credit_installments — adiciona covered_amount e indice FIFO ───────
-- Se a tabela foi criada acima (DB limpo), covered_amount ja esta incluida.
-- Se ja existia (producao), o IF NOT EXISTS e no-op.
ALTER TABLE credit_installments
  ADD COLUMN IF NOT EXISTS covered_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN credit_installments.covered_amount
  IS 'Cobertura FIFO alocada pelo applyPayment. Parcela paga quando covered_amount >= amount_due.';

CREATE INDEX IF NOT EXISTS idx_ci_fifo
  ON credit_installments (company_id, customer_id, status, due_date);
