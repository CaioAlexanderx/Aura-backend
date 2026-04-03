-- ============================================================
-- AURA. Migration 026 — Barber: Cash Register + Tips + Blocks
-- B-04: Daily cash register (open/close/sangria/suprimento)
-- B-05: Tips field on appointments
-- B-08: Schedule blocks (lunch, days off)
-- ============================================================

-- B-04: Cash register sessions
CREATE TABLE IF NOT EXISTS barber_cash_register (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  opened_by     UUID NOT NULL REFERENCES users(id),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opening_amount NUMERIC(12,2) DEFAULT 0,
  closed_by     UUID REFERENCES users(id),
  closed_at     TIMESTAMPTZ,
  closing_amount NUMERIC(12,2),
  expected_amount NUMERIC(12,2),
  difference    NUMERIC(12,2),
  notes         TEXT,
  status        VARCHAR(20) DEFAULT 'open',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_cash_company ON barber_cash_register(company_id, status);

-- B-04: Cash movements (sales, sangria, suprimento, tip)
CREATE TABLE IF NOT EXISTS barber_cash_movements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  register_id     UUID NOT NULL REFERENCES barber_cash_register(id) ON DELETE CASCADE,
  type            VARCHAR(30) NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  payment_method  VARCHAR(30),
  description     TEXT,
  professional_id UUID REFERENCES barbershop_professionals(id),
  appointment_id  UUID,
  created_by      UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_cash_moves ON barber_cash_movements(register_id);

COMMENT ON COLUMN barber_cash_movements.type IS 'venda, sangria, suprimento, gorjeta, produto, ajuste';

-- B-05: Add tip fields to barbershop_appointments
ALTER TABLE barbershop_appointments ADD COLUMN IF NOT EXISTS tip_amount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE barbershop_appointments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30);

-- B-08: Schedule blocks (lunch, day off, vacation)
CREATE TABLE IF NOT EXISTS barber_schedule_blocks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  professional_id UUID NOT NULL REFERENCES barbershop_professionals(id) ON DELETE CASCADE,
  block_type      VARCHAR(30) NOT NULL DEFAULT 'block',
  title           VARCHAR(100),
  start_at        TIMESTAMPTZ NOT NULL,
  end_at          TIMESTAMPTZ NOT NULL,
  recurrence      VARCHAR(30),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_barber_blocks ON barber_schedule_blocks(company_id, professional_id, start_at);

COMMENT ON COLUMN barber_schedule_blocks.block_type IS 'almoco, folga, ferias, bloqueio, intervalo';
COMMENT ON COLUMN barber_schedule_blocks.recurrence IS 'null=once, daily, weekly, monthly';
