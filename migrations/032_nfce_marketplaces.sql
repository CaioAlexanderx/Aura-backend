-- ============================================================
-- AURA. Migration 032 — MKT-02: NFC-e + MKT-03: Marketplaces
-- NFC-e: Cupom fiscal eletrônico para varejo
-- Marketplaces: Mercado Livre, Shopee, etc.
-- ============================================================

-- ===== MKT-02: NFC-e =====

CREATE TABLE IF NOT EXISTS nfce_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  certificate_file VARCHAR(200),
  certificate_password_hash VARCHAR(200),
  csc_id        VARCHAR(10),
  csc_token     VARCHAR(100),
  serie_nfce    INTEGER DEFAULT 1,
  next_number   INTEGER DEFAULT 1,
  ambiente      VARCHAR(20) DEFAULT 'homologacao',
  uf            VARCHAR(2) DEFAULT 'SP',
  inscricao_estadual VARCHAR(20),
  is_active     BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN nfce_config.ambiente IS 'homologacao, producao';
COMMENT ON COLUMN nfce_config.csc_id IS 'Codigo de Seguranca do Contribuinte (ID)';
COMMENT ON COLUMN nfce_config.csc_token IS 'Token CSC para QR Code NFC-e';

CREATE TABLE IF NOT EXISTS nfce_emissions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id       UUID,
  transaction_id UUID REFERENCES transactions(id),
  numero        INTEGER NOT NULL,
  serie         INTEGER DEFAULT 1,
  chave_acesso  VARCHAR(44),
  protocolo     VARCHAR(20),
  status        VARCHAR(20) DEFAULT 'pendente',
  xml_url       TEXT,
  danfe_url     TEXT,
  qrcode_url    TEXT,
  customer_cpf  VARCHAR(14),
  customer_name VARCHAR(200),
  items         JSONB NOT NULL DEFAULT '[]',
  total_products NUMERIC(14,2) DEFAULT 0,
  total_discount NUMERIC(14,2) DEFAULT 0,
  total_nfce    NUMERIC(14,2) DEFAULT 0,
  payment_method VARCHAR(30),
  payment_change NUMERIC(14,2) DEFAULT 0,
  cancel_reason TEXT,
  cancelled_at  TIMESTAMPTZ,
  authorized_at TIMESTAMPTZ,
  emitted_by    UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nfce_company ON nfce_emissions(company_id, status);
CREATE INDEX IF NOT EXISTS idx_nfce_chave ON nfce_emissions(chave_acesso);

COMMENT ON COLUMN nfce_emissions.status IS 'pendente, processando, autorizada, rejeitada, cancelada, inutilizada';
COMMENT ON COLUMN nfce_emissions.items IS 'Array of {product_name, ncm, cfop, quantity, unit_price, total, icms_cst, icms_aliq}';

-- ===== MKT-03: Marketplaces =====

CREATE TABLE IF NOT EXISTS marketplace_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  platform      VARCHAR(30) NOT NULL,
  store_name    VARCHAR(200),
  store_id      VARCHAR(100),
  access_token  TEXT,
  refresh_token TEXT,
  token_expires TIMESTAMPTZ,
  status        VARCHAR(20) DEFAULT 'pendente',
  sync_products BOOLEAN DEFAULT true,
  sync_orders   BOOLEAN DEFAULT true,
  sync_stock    BOOLEAN DEFAULT true,
  last_sync     TIMESTAMPTZ,
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mkt_connections ON marketplace_connections(company_id, platform);
COMMENT ON COLUMN marketplace_connections.platform IS 'mercado_livre, shopee, amazon, magalu, americanas, shein';

CREATE TABLE IF NOT EXISTS marketplace_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  connection_id   UUID NOT NULL REFERENCES marketplace_connections(id) ON DELETE CASCADE,
  platform        VARCHAR(30) NOT NULL,
  external_id     VARCHAR(100) NOT NULL,
  status          VARCHAR(30) DEFAULT 'novo',
  customer_name   VARCHAR(200),
  customer_doc    VARCHAR(20),
  shipping_address JSONB,
  items           JSONB NOT NULL DEFAULT '[]',
  subtotal        NUMERIC(14,2) DEFAULT 0,
  shipping_cost   NUMERIC(14,2) DEFAULT 0,
  marketplace_fee NUMERIC(14,2) DEFAULT 0,
  total           NUMERIC(14,2) DEFAULT 0,
  net_revenue     NUMERIC(14,2) DEFAULT 0,
  payment_method  VARCHAR(30),
  paid_at         TIMESTAMPTZ,
  shipped_at      TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  tracking_code   VARCHAR(50),
  nfce_id         UUID REFERENCES nfce_emissions(id),
  transaction_id  UUID REFERENCES transactions(id),
  external_data   JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mkt_orders ON marketplace_orders(company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_orders_ext ON marketplace_orders(connection_id, external_id);

COMMENT ON COLUMN marketplace_orders.status IS 'novo, pago, separando, enviado, entregue, cancelado, devolvido';
COMMENT ON COLUMN marketplace_orders.items IS 'Array of {product_id, sku, name, quantity, unit_price, total}';

-- Product mapping (Aura product <-> marketplace listing)
CREATE TABLE IF NOT EXISTS marketplace_product_map (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  connection_id   UUID NOT NULL REFERENCES marketplace_connections(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  external_id     VARCHAR(100) NOT NULL,
  external_sku    VARCHAR(50),
  external_url    TEXT,
  sync_price      BOOLEAN DEFAULT true,
  sync_stock      BOOLEAN DEFAULT true,
  price_markup    NUMERIC(5,2) DEFAULT 0,
  last_synced     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_prodmap ON marketplace_product_map(connection_id, product_id);
