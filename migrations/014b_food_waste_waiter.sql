-- ============================================================
-- AURA. — Migration 014b: Food Service (complemento)
-- Tabelas: desperdício e chamadas de garçom
-- ============================================================

-- Desperdício de ingredientes/itens (FOOD-05)
CREATE TABLE IF NOT EXISTS food_waste_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id         UUID REFERENCES food_items(id) ON DELETE SET NULL,
  ingredient_name TEXT NOT NULL,          -- nome livre ou do item
  quantity        NUMERIC(10,4) NOT NULL,
  unit            TEXT NOT NULL DEFAULT 'un',
  unit_cost       NUMERIC(10,4) NOT NULL DEFAULT 0,
  total_cost      NUMERIC(10,4) GENERATED ALWAYS AS (quantity * unit_cost) STORED,
  reason          TEXT,                   -- 'validade','preparo','acidente','sobra'
  recorded_by     UUID REFERENCES employees(id) ON DELETE SET NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chamadas de garçom via QR da mesa (FOOD-07)
CREATE TABLE IF NOT EXISTS food_waiter_calls (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  table_id    UUID NOT NULL REFERENCES food_tables(id) ON DELETE CASCADE,
  reason      TEXT DEFAULT 'Chamada',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','answered')),
  answered_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  answered_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_waste_company  ON food_waste_logs(company_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_food_waiter_calls   ON food_waiter_calls(company_id, status);

ALTER TABLE food_waste_logs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_waiter_calls  ENABLE ROW LEVEL SECURITY;

-- Coluna source para rastrear origem do pedido (iFood, etc.) — FOOD-06
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS external_id   TEXT,   -- ID do pedido no iFood/Rappi
  ADD COLUMN IF NOT EXISTS source        TEXT DEFAULT 'aura', -- aura|ifood|rappi|csv_import
  ADD COLUMN IF NOT EXISTS imported_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_food_orders_source ON food_orders(company_id, source);
