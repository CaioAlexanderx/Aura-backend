-- ============================================================
-- Migration 007 — Modo Salão Parceiro (BE-22)
-- Lei nº 13.352/2016 — Parceria entre salões e profissionais PJ
-- ============================================================

CREATE TABLE IF NOT EXISTS salon_partners (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  cnpj            TEXT,
  partner_share   NUMERIC(5,2) NOT NULL
                  CHECK (partner_share > 0 AND partner_share < 100),
  salon_share     NUMERIC(5,2) GENERATED ALWAYS AS (100 - partner_share) STORED,
  pix_key         TEXT,
  notes           TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_salon_partners_company ON salon_partners(company_id, is_active);

CREATE TABLE IF NOT EXISTS salon_partner_splits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_id      UUID NOT NULL REFERENCES salon_partners(id) ON DELETE RESTRICT,
  sale_id         UUID REFERENCES sales(id) ON DELETE SET NULL,
  service_amount  NUMERIC(12,2) NOT NULL,
  partner_share   NUMERIC(5,2)  NOT NULL,
  partner_amount  NUMERIC(12,2) NOT NULL,
  salon_amount    NUMERIC(12,2) NOT NULL,
  reference_month DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'paid', 'cancelled')),
  paid_at         TIMESTAMPTZ,
  nfe_key         TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_splits_company ON salon_partner_splits(company_id, reference_month);
CREATE INDEX idx_splits_partner ON salon_partner_splits(partner_id, status);
CREATE INDEX idx_splits_sale    ON salon_partner_splits(sale_id);

COMMENT ON TABLE salon_partners IS
  'Parceiros PJ do salão. Lei 13.352/2016: cota do parceiro excluída do faturamento tributável do salão.';
COMMENT ON TABLE salon_partner_splits IS
  'Divisão de receita por atendimento. salon_amount = base tributável do salão.';
COMMENT ON COLUMN salon_partner_splits.nfe_key IS
  'Preenchido pelo BE-12 quando NF-e real for emitida via NFE.io.';
