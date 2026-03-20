-- ============================================================
-- AURA. — Migration 001: Schema Inicial
-- Compatível com: PostgreSQL 15+ / Supabase
-- Atualizado: 19/03/2026
-- ============================================================

-- Habilitar extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE plan_type AS ENUM ('essencial', 'negocio', 'expansao');

CREATE TYPE tax_regime AS ENUM ('mei', 'simples_nacional', 'lucro_presumido', 'lucro_real');

CREATE TYPE transaction_type AS ENUM ('income', 'expense');

CREATE TYPE transaction_status AS ENUM ('pending', 'confirmed', 'cancelled');

CREATE TYPE obligation_status AS ENUM ('pending', 'completed', 'overdue', 'skipped');

CREATE TYPE payroll_status AS ENUM ('draft', 'confirmed', 'paid');

CREATE TYPE user_role AS ENUM ('client', 'analyst', 'admin');

CREATE TYPE nfe_status AS ENUM ('draft', 'issued', 'cancelled');

CREATE TYPE payment_link_status AS ENUM ('pending', 'paid', 'expired', 'cancelled');

CREATE TYPE barcode_format AS ENUM ('EAN-13', 'EAN-8', 'CODE-128', 'QR');

-- ============================================================
-- TABELA: users
-- ============================================================

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'client',
  crc_number    TEXT,                          -- preenchido se role = analyst
  phone         TEXT,
  avatar_url    TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role  ON users(role);

-- ============================================================
-- TABELA: companies
-- ============================================================

CREATE TABLE companies (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  analyst_id        UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Dados cadastrais
  cnpj              TEXT UNIQUE,
  legal_name        TEXT NOT NULL,
  trade_name        TEXT,
  email             TEXT,
  phone             TEXT,
  website           TEXT,

  -- Endereço
  street            TEXT,
  number            TEXT,
  complement        TEXT,
  neighborhood      TEXT,
  city              TEXT,
  state             CHAR(2),
  zip_code          TEXT,

  -- Configuração fiscal
  tax_regime        tax_regime NOT NULL DEFAULT 'mei',
  plan              plan_type NOT NULL DEFAULT 'essencial',
  monthly_revenue   NUMERIC(12,2) DEFAULT 0,    -- faturamento acumulado mês atual
  annual_revenue    NUMERIC(12,2) DEFAULT 0,    -- faturamento acumulado ano (limite MEI R$81k)

  -- Vertical ativo
  vertical_active   TEXT,                       -- 'odonto' | 'salao' | 'estetica' | NULL
  vertical_enabled_at TIMESTAMPTZ,

  -- Controle
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_companies_owner    ON companies(owner_id);
CREATE INDEX idx_companies_analyst  ON companies(analyst_id);
CREATE INDEX idx_companies_cnpj     ON companies(cnpj);
CREATE INDEX idx_companies_plan     ON companies(plan);

-- ============================================================
-- TABELA: company_members  (multi-usuário — BE-09)
-- Estrutura criada agora para evitar migration complexa depois
-- ============================================================

CREATE TABLE company_members (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_label    TEXT NOT NULL DEFAULT 'employee',   -- ex: 'vendedor', 'gerente'
  permissions   JSONB NOT NULL DEFAULT '{}',        -- granular: {"pdv":true,"estoque":false}
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, user_id)
);

CREATE INDEX idx_members_company ON company_members(company_id);

-- ============================================================
-- TABELA: products
-- ============================================================

CREATE TABLE products (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Dados básicos
  name            TEXT NOT NULL,
  description     TEXT,
  category        TEXT,
  sku             TEXT,
  unit            TEXT DEFAULT 'un',

  -- Código de barras (BE-13)
  barcode         TEXT,
  barcode_format  barcode_format,

  -- Preço e estoque
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost_price      NUMERIC(10,2) DEFAULT 0,
  stock_qty       NUMERIC(10,3) NOT NULL DEFAULT 0,
  stock_min       NUMERIC(10,3) DEFAULT 0,          -- alerta estoque mínimo
  stock_max       NUMERIC(10,3),

  -- Custo Avançado (plano Expansão)
  advanced_cost_enabled BOOLEAN DEFAULT false,
  weighted_avg_cost     NUMERIC(10,4),              -- CMV ponderado

  -- Controle
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, barcode)                      -- barcode único por empresa
);

CREATE INDEX idx_products_company  ON products(company_id);
CREATE INDEX idx_products_barcode  ON products(company_id, barcode);
CREATE INDEX idx_products_category ON products(company_id, category);

-- ============================================================
-- TABELAS: variantes de produto (BE-16)
-- ============================================================

CREATE TABLE product_variant_attributes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                    -- ex: "Cor", "Tamanho", "Sabor"
  vertical_hint   TEXT,                             -- ex: 'moda', 'pet', NULL (global)
  sort_order      SMALLINT DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE product_variants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku_suffix      TEXT,                             -- ex: "ROSA-38"
  price_override  NUMERIC(10,2),                    -- NULL = usa preço do produto
  stock_qty       NUMERIC(10,3) NOT NULL DEFAULT 0,
  barcode         TEXT,
  barcode_format  barcode_format,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE product_variant_values (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  variant_id      UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  attribute_name  TEXT NOT NULL,                    -- texto livre: "Cor", "Tamanho"
  value           TEXT NOT NULL,                    -- texto livre: "Rosa", "38", "M"
  UNIQUE (variant_id, attribute_name)               -- uma variante não repete atributo
);

CREATE INDEX idx_variants_product  ON product_variants(product_id);
CREATE INDEX idx_variant_vals      ON product_variant_values(variant_id);

-- ============================================================
-- TABELA: transactions
-- ============================================================

CREATE TABLE transactions (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  idempotency_key  TEXT UNIQUE,                     -- previne duplicatas em POST

  type             transaction_type NOT NULL,
  status           transaction_status NOT NULL DEFAULT 'pending',
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  description      TEXT NOT NULL,
  category         TEXT,
  due_date         DATE NOT NULL,
  paid_at          TIMESTAMPTZ,

  -- Recorrência
  is_recurring     BOOLEAN DEFAULT false,
  recurrence_rule  TEXT,                            -- 'monthly' | 'weekly' | 'yearly'

  -- NF-e vinculada
  nfe_id           UUID,

  -- Metadados
  notes            TEXT,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_transactions_company    ON transactions(company_id);
CREATE INDEX idx_transactions_due_date   ON transactions(company_id, due_date);
CREATE INDEX idx_transactions_type       ON transactions(company_id, type);
CREATE INDEX idx_transactions_status     ON transactions(company_id, status);
CREATE INDEX idx_transactions_idem       ON transactions(idempotency_key);

-- ============================================================
-- TABELA: sales (PDV)
-- ============================================================

CREATE TABLE sales (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     UUID,                             -- FK em customers (abaixo)
  seller_id       UUID REFERENCES users(id),

  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  payment_method  TEXT,                             -- 'pix'|'dinheiro'|'cartao_debito'|'cartao_credito'|'fiado'
  notes           TEXT,

  nfe_id          UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sales_company    ON sales(company_id);
CREATE INDEX idx_sales_customer   ON sales(customer_id);
CREATE INDEX idx_sales_seller     ON sales(seller_id);
CREATE INDEX idx_sales_created_at ON sales(company_id, created_at);

CREATE TABLE sale_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sale_id         UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id      UUID NOT NULL REFERENCES products(id),
  variant_id      UUID REFERENCES product_variants(id),

  quantity        NUMERIC(10,3) NOT NULL,
  unit_price      NUMERIC(10,2) NOT NULL,
  unit_cost       NUMERIC(10,2),                    -- CMV no momento da venda
  discount        NUMERIC(10,2) DEFAULT 0,
  total_price     NUMERIC(12,2) NOT NULL
);

CREATE INDEX idx_sale_items_sale    ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

-- ============================================================
-- TABELA: customers (CRM)
-- ============================================================

CREATE TABLE customers (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Dados básicos
  name                TEXT NOT NULL,
  cpf_cnpj            TEXT,
  email               TEXT,
  phone               TEXT,
  birth_date          DATE,

  -- Social (BE-05)
  instagram_handle    TEXT,
  follows_instagram   BOOLEAN DEFAULT false,

  -- Endereço
  street              TEXT,
  number              TEXT,
  complement          TEXT,
  city                TEXT,
  state               CHAR(2),
  zip_code            TEXT,

  -- Métricas calculadas (atualizadas via trigger/worker)
  total_purchases     INT NOT NULL DEFAULT 0,
  total_spent         NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_purchase_at    TIMESTAMPTZ,
  first_purchase_at   TIMESTAMPTZ,

  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sales ADD CONSTRAINT fk_sales_customer
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX idx_customers_company    ON customers(company_id);
CREATE INDEX idx_customers_phone      ON customers(company_id, phone);
CREATE INDEX idx_customers_birth_date ON customers(company_id, birth_date);
CREATE INDEX idx_customers_ltv        ON customers(company_id, total_spent DESC);

-- ============================================================
-- TABELA: purchase_reviews (BE-06)
-- ============================================================

CREATE TABLE purchase_reviews (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id         UUID REFERENCES sales(id) ON DELETE SET NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,

  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  sent_to_google  BOOLEAN DEFAULT false,    -- redirect feito (NUNCA condicional à nota)
  responded_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reviews_company ON purchase_reviews(company_id);

-- ============================================================
-- TABELA: nfe (NF-e / NFS-e)
-- ============================================================

CREATE TABLE nfe (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id         UUID REFERENCES sales(id) ON DELETE SET NULL,

  type            TEXT NOT NULL,                    -- 'nfe' | 'nfse'
  status          nfe_status NOT NULL DEFAULT 'draft',
  number          TEXT,
  series          TEXT DEFAULT '1',
  key             TEXT UNIQUE,                      -- chave de acesso 44 dígitos
  xml_url         TEXT,                             -- Cloudflare R2
  pdf_url         TEXT,
  issued_at       TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,

  -- Dados fiscais
  total_amount    NUMERIC(12,2),
  tax_amount      NUMERIC(12,2),
  cfop            TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_nfe_company ON nfe(company_id);
CREATE INDEX idx_nfe_status  ON nfe(company_id, status);

-- ============================================================
-- TABELA: payment_links
-- ============================================================

CREATE TABLE payment_links (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  transaction_id  UUID REFERENCES transactions(id) ON DELETE SET NULL,

  amount          NUMERIC(12,2) NOT NULL,
  description     TEXT,
  status          payment_link_status NOT NULL DEFAULT 'pending',

  -- PIX
  pix_qrcode      TEXT,
  pix_key         TEXT,
  pix_expiry      TIMESTAMPTZ,

  -- Controle TTL (JWT 7 dias)
  token           TEXT UNIQUE,
  expires_at      TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,

  -- Webhook
  webhook_url     TEXT,
  webhook_secret  TEXT,                             -- HMAC-SHA256
  webhook_sent_at TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_links_company ON payment_links(company_id);
CREATE INDEX idx_payment_links_token   ON payment_links(token);
CREATE INDEX idx_payment_links_status  ON payment_links(company_id, status);

-- ============================================================
-- TABELAS: obrigações fiscais
-- ============================================================

CREATE TABLE fiscal_obligations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  code            TEXT NOT NULL,                    -- 'DAS_MEI' | 'DASN_SIMEI' | 'PGDAS_D' | 'DEFIS' | 'IRPF'
  description     TEXT NOT NULL,
  due_date        DATE NOT NULL,
  reference_period TEXT,                            -- ex: '2026-02' (mês/ano referência)
  status          obligation_status NOT NULL DEFAULT 'pending',

  -- Valores estimados (NUNCA declarações oficiais)
  estimated_amount NUMERIC(12,2),
  das_qrcode      TEXT,

  -- Checkpoints gamificados
  checkpoint_total   SMALLINT DEFAULT 0,
  checkpoint_done    SMALLINT DEFAULT 0,
  streak_days        SMALLINT DEFAULT 0,

  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_obligations_company  ON fiscal_obligations(company_id);
CREATE INDEX idx_obligations_due_date ON fiscal_obligations(company_id, due_date);
CREATE INDEX idx_obligations_status   ON fiscal_obligations(company_id, status);

-- ============================================================
-- TABELAS: folha de pagamento
-- ============================================================

CREATE TABLE employees (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id),

  name            TEXT NOT NULL,
  cpf             TEXT NOT NULL,
  role_title      TEXT,
  base_salary     NUMERIC(10,2) NOT NULL,
  admission_date  DATE NOT NULL,
  dismissal_date  DATE,

  -- Dados ESOCIAL/FGTS
  pis_pasep       TEXT,
  fgts_account    TEXT,
  ctps_number     TEXT,

  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, cpf)
);

CREATE TABLE payroll_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference_month DATE NOT NULL,                    -- primeiro dia do mês
  status          payroll_status NOT NULL DEFAULT 'draft',

  total_gross     NUMERIC(12,2),
  total_inss      NUMERIC(12,2),
  total_irrf      NUMERIC(12,2),
  total_fgts      NUMERIC(12,2),
  total_net       NUMERIC(12,2),

  confirmed_at    TIMESTAMPTZ,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, reference_month)
);

CREATE TABLE payroll_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payroll_run_id  UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id     UUID NOT NULL REFERENCES employees(id),

  gross_salary    NUMERIC(10,2) NOT NULL,
  inss_employee   NUMERIC(10,2) NOT NULL,
  irrf            NUMERIC(10,2) NOT NULL,
  fgts            NUMERIC(10,2) NOT NULL,
  other_deductions NUMERIC(10,2) DEFAULT 0,
  other_additions  NUMERIC(10,2) DEFAULT 0,
  net_salary      NUMERIC(10,2) NOT NULL,

  holerite_url    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employees_company   ON employees(company_id);
CREATE INDEX idx_payroll_runs_company ON payroll_runs(company_id);
CREATE INDEX idx_payroll_items_run   ON payroll_items(payroll_run_id);

-- ============================================================
-- TABELAS: tabelas fiscais parametrizáveis (ano-base)
-- ============================================================

CREATE TABLE tax_inss_brackets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  year_base       SMALLINT NOT NULL,
  min_salary      NUMERIC(10,2) NOT NULL,
  max_salary      NUMERIC(10,2),                    -- NULL = sem limite superior
  rate            NUMERIC(5,4) NOT NULL,            -- ex: 0.0750 = 7,5%
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year_base, min_salary)
);

CREATE TABLE tax_irrf_brackets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  year_base       SMALLINT NOT NULL,
  min_base        NUMERIC(10,2) NOT NULL,
  max_base        NUMERIC(10,2),
  rate            NUMERIC(5,4) NOT NULL,
  deduction       NUMERIC(10,2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year_base, min_base)
);

-- ============================================================
-- TABELA: audit_logs
-- ============================================================

CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID REFERENCES companies(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,

  action          TEXT NOT NULL,                    -- ex: 'tax_regime.changed'
  entity_type     TEXT,                             -- ex: 'company'
  entity_id       UUID,
  old_value       JSONB,
  new_value       JSONB,
  ip_address      INET,
  user_agent      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_company   ON audit_logs(company_id, created_at DESC);
CREATE INDEX idx_audit_entity    ON audit_logs(entity_type, entity_id);

-- ============================================================
-- FUNÇÃO: updated_at automático
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_obligations_updated_at
  BEFORE UPDATE ON fiscal_obligations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_employees_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_variants_updated_at
  BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- FUNÇÃO: atualizar métricas do cliente após venda
-- ============================================================

CREATE OR REPLACE FUNCTION update_customer_metrics()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.customer_id IS NOT NULL THEN
    UPDATE customers SET
      total_purchases  = (SELECT COUNT(*) FROM sales WHERE customer_id = NEW.customer_id AND company_id = NEW.company_id),
      total_spent      = (SELECT COALESCE(SUM(total_amount), 0) FROM sales WHERE customer_id = NEW.customer_id AND company_id = NEW.company_id),
      last_purchase_at = NOW(),
      first_purchase_at = LEAST(first_purchase_at, NOW()),
      updated_at       = NOW()
    WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sale_update_customer
  AFTER INSERT ON sales
  FOR EACH ROW EXECUTE FUNCTION update_customer_metrics();

-- ============================================================
-- ROW LEVEL SECURITY (RLS) — Supabase
-- ============================================================

ALTER TABLE companies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees        ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_links    ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfe              ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_reviews ENABLE ROW LEVEL SECURITY;

-- Política base: client vê apenas sua empresa
-- Analista e admin vêem todas (gerenciado via backend RBAC)
-- Policies expandidas serão adicionadas após definição do auth Supabase

-- ============================================================
-- FIM DA MIGRATION 001
-- ============================================================
