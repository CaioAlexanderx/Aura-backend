-- ============================================================
-- AURA. Migration 029 — Barber Tier 2
-- B-09: Packages, B-10: Subscriptions, B-11: Gift cards
-- B-12: Booking config, B-14: Recurring, B-15: Service materials
-- ============================================================

-- B-09: Service packages (4 cortes + 2 barbas = R$249)
CREATE TABLE IF NOT EXISTS barber_packages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  description   TEXT,
  services      JSONB NOT NULL DEFAULT '[]',
  total_sessions INTEGER NOT NULL DEFAULT 1,
  price         NUMERIC(12,2) NOT NULL,
  original_price NUMERIC(12,2),
  validity_days INTEGER DEFAULT 90,
  is_active     BOOLEAN DEFAULT true,
  sold_count    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_packages ON barber_packages(company_id, is_active);

COMMENT ON COLUMN barber_packages.services IS 'Array of {service_id, service_name, quantity}';

-- B-09: Customer package purchases
CREATE TABLE IF NOT EXISTS barber_package_purchases (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  package_id    UUID NOT NULL REFERENCES barber_packages(id),
  customer_id   UUID REFERENCES customers(id),
  customer_name VARCHAR(200),
  sessions_used INTEGER DEFAULT 0,
  sessions_total INTEGER NOT NULL,
  amount_paid   NUMERIC(12,2) NOT NULL,
  purchased_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  status        VARCHAR(20) DEFAULT 'ativo',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_purchases ON barber_package_purchases(company_id, status);

-- B-10: Subscriptions (clube mensal)
CREATE TABLE IF NOT EXISTS barber_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          VARCHAR(200) NOT NULL,
  description   TEXT,
  monthly_price NUMERIC(12,2) NOT NULL,
  included_services JSONB NOT NULL DEFAULT '[]',
  is_active     BOOLEAN DEFAULT true,
  subscribers_count INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS barber_subscriber (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES barber_subscriptions(id),
  customer_id     UUID REFERENCES customers(id),
  customer_name   VARCHAR(200),
  status          VARCHAR(20) DEFAULT 'ativo',
  started_at      TIMESTAMPTZ DEFAULT NOW(),
  next_billing    DATE,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- B-11: Gift cards
CREATE TABLE IF NOT EXISTS barber_gift_cards (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code          VARCHAR(20) NOT NULL UNIQUE,
  initial_amount NUMERIC(12,2) NOT NULL,
  balance       NUMERIC(12,2) NOT NULL,
  buyer_name    VARCHAR(200),
  recipient_name VARCHAR(200),
  message       TEXT,
  expires_at    TIMESTAMPTZ,
  redeemed_at   TIMESTAMPTZ,
  status        VARCHAR(20) DEFAULT 'ativo',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_gc_code ON barber_gift_cards(code);
CREATE INDEX IF NOT EXISTS idx_barber_gc_company ON barber_gift_cards(company_id, status);

-- B-12: Public booking config (barber version)
CREATE TABLE IF NOT EXISTS barber_booking_config (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  is_active     BOOLEAN DEFAULT false,
  slug          VARCHAR(50) UNIQUE,
  welcome_msg   TEXT DEFAULT 'Agende seu horario online',
  min_advance_hours INTEGER DEFAULT 1,
  max_advance_days  INTEGER DEFAULT 14,
  available_days    JSONB DEFAULT '[1,2,3,4,5,6]'::jsonb,
  start_hour    INTEGER DEFAULT 8,
  end_hour      INTEGER DEFAULT 20,
  require_phone BOOLEAN DEFAULT true,
  allow_professional_choice BOOLEAN DEFAULT true,
  deposit_required BOOLEAN DEFAULT false,
  deposit_amount NUMERIC(12,2) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS barber_booking_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_name   VARCHAR(200) NOT NULL,
  customer_phone  VARCHAR(20),
  professional_id UUID REFERENCES barbershop_professionals(id),
  service_id      UUID REFERENCES barbershop_services(id),
  service_name    VARCHAR(200),
  preferred_date  DATE NOT NULL,
  preferred_time  TIME NOT NULL,
  status          VARCHAR(20) DEFAULT 'pendente',
  appointment_id  UUID REFERENCES barbershop_appointments(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_booking_reqs ON barber_booking_requests(company_id, status);

-- B-14: Recurring appointments
CREATE TABLE IF NOT EXISTS barber_recurring_appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     UUID REFERENCES customers(id),
  customer_name   VARCHAR(200) NOT NULL,
  professional_id UUID NOT NULL REFERENCES barbershop_professionals(id),
  service_id      UUID REFERENCES barbershop_services(id),
  service_name    VARCHAR(200),
  day_of_week     INTEGER NOT NULL,
  time_slot       TIME NOT NULL,
  duration_min    INTEGER DEFAULT 30,
  is_active       BOOLEAN DEFAULT true,
  last_generated  DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON COLUMN barber_recurring_appointments.day_of_week IS '0=domingo, 1=segunda, ..., 6=sabado';

-- B-15: Service materials (estoque uso interno)
CREATE TABLE IF NOT EXISTS barber_service_materials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  service_id    UUID NOT NULL REFERENCES barbershop_services(id) ON DELETE CASCADE,
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity_per_use NUMERIC(10,3) NOT NULL DEFAULT 1,
  unit          VARCHAR(20) DEFAULT 'un',
  auto_debit    BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_materials ON barber_service_materials(service_id);

COMMENT ON COLUMN barber_service_materials.unit IS 'un, ml, g, dose';

-- B-16: Product commission field on professionals
ALTER TABLE barbershop_professionals ADD COLUMN IF NOT EXISTS product_commission_pct NUMERIC(5,2) DEFAULT 0;
