-- ============================================================
-- Migration 100 — Freelancers
-- ============================================================
-- Tabela separada de employees (decisao 06/05/2026): freelancers
-- tem regime de pagamento e dados fiscais distintos do CLT.
-- Schema proprio:
--   - doc_type + doc (CPF ou CNPJ)
--   - payment_period (day/week/month) + payment_amount
--   - pix_key + pix_type (chave de recebimento)
--   - category (tag livre: designer, dev, marketing...)
-- Idempotente. Soft-delete via is_active = false.
-- ============================================================

CREATE TABLE IF NOT EXISTS freelancers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Identidade
  name VARCHAR(200) NOT NULL,
  doc_type VARCHAR(4) NOT NULL DEFAULT 'cpf' CHECK (doc_type IN ('cpf', 'cnpj')),
  doc VARCHAR(20),

  -- Contato
  email VARCHAR(255),
  phone VARCHAR(20),

  -- Pagamento (decisao: valor por periodo com seletor)
  payment_period VARCHAR(10) NOT NULL DEFAULT 'month'
    CHECK (payment_period IN ('day', 'week', 'month', 'project', 'hour')),
  payment_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,

  -- PIX
  pix_type VARCHAR(10) CHECK (pix_type IN ('cpf', 'cnpj', 'email', 'phone', 'random') OR pix_type IS NULL),
  pix_key VARCHAR(100),

  -- Categorizacao (tag livre)
  category VARCHAR(80),

  -- Observacoes
  notes TEXT,

  -- Estado
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'paused')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  -- Auditoria
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pra listagem rapida por company + ativos
CREATE INDEX IF NOT EXISTS idx_freelancers_company_active
  ON freelancers (company_id, is_active, status);

-- UNIQUE parcial: evita duplicidade de doc por company so quando ativo.
-- Permite recadastro apos soft-delete (mesmo padrao do fix de employees).
CREATE UNIQUE INDEX IF NOT EXISTS uq_freelancers_company_doc_active
  ON freelancers (company_id, doc)
  WHERE is_active = TRUE AND doc IS NOT NULL;

-- Trigger pra updated_at automatico (reusa fn existente do schema)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_freelancers_updated_at ON freelancers;
    CREATE TRIGGER trg_freelancers_updated_at
      BEFORE UPDATE ON freelancers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMENT ON TABLE freelancers IS 'Cadastro de freelancers/PJ separado de employees — payment_period + payment_amount + pix';
COMMENT ON COLUMN freelancers.payment_period IS 'day|week|month|project|hour — define como o payment_amount eh interpretado';
COMMENT ON COLUMN freelancers.is_active IS 'Soft-delete. Recadastro com mesmo doc reativa via app';
