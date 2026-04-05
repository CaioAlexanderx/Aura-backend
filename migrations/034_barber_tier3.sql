-- ============================================================
-- AURA. Migration 034 — S11: Barber Tier 3 (Premium)
-- B-17: NFS-e parceiro (Lei do Salão)
-- B-18: Cota-parte NF
-- B-19: Fidelidade pontos
-- B-20: Dose/grama
-- B-21: Reserve with Google
-- ============================================================

-- B-17/B-18: Partner NFS-e tracking (Lei do Salão 13.352/2016)
CREATE TABLE IF NOT EXISTS barber_partner_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  partner_id      UUID NOT NULL REFERENCES salon_partners(id),
  professional_id UUID REFERENCES barbershop_professionals(id),
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  gross_revenue   NUMERIC(14,2) NOT NULL DEFAULT 0,
  partner_share   NUMERIC(14,2) NOT NULL DEFAULT 0,
  salon_share     NUMERIC(14,2) NOT NULL DEFAULT 0,
  partner_share_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  deductions      NUMERIC(14,2) DEFAULT 0,
  deduction_details JSONB DEFAULT '[]',
  partner_nfse_number VARCHAR(30),
  partner_nfse_status VARCHAR(20) DEFAULT 'pendente',
  partner_nfse_url TEXT,
  salon_nfse_number VARCHAR(30),
  salon_nfse_status VARCHAR(20) DEFAULT 'pendente',
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_invoices ON barber_partner_invoices(company_id, period_start);

COMMENT ON COLUMN barber_partner_invoices.partner_nfse_status IS 'pendente, emitida, erro';
COMMENT ON COLUMN barber_partner_invoices.deduction_details IS 'Array of {description, amount} — aluguel cadeira, produtos, etc';

-- B-19: Loyalty points program
CREATE TABLE IF NOT EXISTS barber_loyalty_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  is_active       BOOLEAN DEFAULT false,
  points_per_real NUMERIC(5,2) DEFAULT 1,
  redemption_rate NUMERIC(5,2) DEFAULT 100,
  welcome_points  INTEGER DEFAULT 0,
  birthday_bonus  INTEGER DEFAULT 0,
  referral_points INTEGER DEFAULT 0,
  expiry_months   INTEGER DEFAULT 12,
  rules           JSONB DEFAULT '[]',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN barber_loyalty_config.points_per_real IS 'Pontos por R$1 gasto';
COMMENT ON COLUMN barber_loyalty_config.redemption_rate IS 'Pontos necessarios para R$1 de desconto';

CREATE TABLE IF NOT EXISTS barber_loyalty_points (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id),
  points          INTEGER NOT NULL,
  type            VARCHAR(20) NOT NULL,
  description     TEXT,
  reference_id    UUID,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_pts ON barber_loyalty_points(company_id, customer_id);
COMMENT ON COLUMN barber_loyalty_points.type IS 'earn, redeem, bonus, expire, welcome, birthday, referral';

-- B-20: Fractional stock (dose/grama)
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_type VARCHAR(10) DEFAULT 'un';
ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_fraction NUMERIC(12,3) DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fraction_unit VARCHAR(10);

COMMENT ON COLUMN products.unit_type IS 'un, ml, g, kg, l, dose';
COMMENT ON COLUMN products.stock_fraction IS 'Estoque fracionado (ex: 450.5 ml de tintura)';
COMMENT ON COLUMN products.fraction_unit IS 'Unidade do fracionamento';

CREATE TABLE IF NOT EXISTS barber_stock_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id),
  professional_id UUID REFERENCES barbershop_professionals(id),
  appointment_id  UUID,
  quantity_used   NUMERIC(10,3) NOT NULL,
  unit            VARCHAR(10) NOT NULL,
  notes           TEXT,
  used_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_usage ON barber_stock_usage(company_id, product_id);

-- B-21: Reserve with Google (Business Profile integration config)
CREATE TABLE IF NOT EXISTS barber_google_booking (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  is_active       BOOLEAN DEFAULT false,
  google_place_id VARCHAR(200),
  business_name   VARCHAR(200),
  business_url    TEXT,
  sync_services   BOOLEAN DEFAULT true,
  sync_availability BOOLEAN DEFAULT true,
  auto_accept     BOOLEAN DEFAULT false,
  last_sync       TIMESTAMPTZ,
  settings        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
