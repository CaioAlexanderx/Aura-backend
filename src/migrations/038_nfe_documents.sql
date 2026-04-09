-- Migration 038: NF-e documents tracking (Focus NFe integration)
-- Sprint 4: NFS-e (Fase 1) + NFCe (Fase 2)

CREATE TABLE IF NOT EXISTS nfe_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ref VARCHAR(100) NOT NULL,
  type VARCHAR(10) NOT NULL DEFAULT 'nfse',
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  focus_id VARCHAR(100),
  number VARCHAR(20),
  serie VARCHAR(5),
  access_key VARCHAR(50),
  xml_url TEXT,
  pdf_url TEXT,
  cancel_xml_url TEXT,
  recipient_cnpj VARCHAR(18),
  recipient_name VARCHAR(255),
  description TEXT,
  service_code VARCHAR(20),
  value NUMERIC(12,2) NOT NULL DEFAULT 0,
  iss_rate NUMERIC(5,2),
  iss_value NUMERIC(12,2),
  error_message TEXT,
  payload JSONB,
  issued_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, ref)
);

CREATE INDEX IF NOT EXISTS idx_nfe_docs_company ON nfe_documents (company_id, type, status);
CREATE INDEX IF NOT EXISTS idx_nfe_docs_ref ON nfe_documents (ref);

-- Company NFe config (certificate, municipal inscription, etc)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS focus_company_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS inscricao_municipal VARCHAR(30),
  ADD COLUMN IF NOT EXISTS certificate_uploaded BOOLEAN DEFAULT false;
