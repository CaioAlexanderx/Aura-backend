-- ============================================================
-- AURA. — Migration 014c: Gestão de Motoboys
-- Aplicar manualmente no Supabase SQL Editor
-- ============================================================

-- ── 1. ENTREGADORES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_deliverers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT,
  vehicle_type    TEXT DEFAULT 'moto'  -- moto | bicicleta | carro | a_pe
    CHECK (vehicle_type IN ('moto','bicicleta','carro','a_pe')),
  vehicle_plate   TEXT,
  commission_pct  NUMERIC(5,2) NOT NULL DEFAULT 0,  -- % sobre valor da entrega
  commission_fixed NUMERIC(10,2) NOT NULL DEFAULT 0, -- valor fixo por entrega
  -- commission_mode: 'pct' usa commission_pct, 'fixed' usa commission_fixed
  commission_mode TEXT NOT NULL DEFAULT 'fixed'
    CHECK (commission_mode IN ('pct','fixed')),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. VINCULAR ENTREGADOR AO PEDIDO ─────────────────────────
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS deliverer_id UUID REFERENCES food_deliverers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ,   -- quando saiu para entrega
  ADD COLUMN IF NOT EXISTS deliverer_commission NUMERIC(10,2); -- comissão calculada no despacho

-- ── 3. HISTÓRICO DE DESPACHOS ────────────────────────────────
-- Permite rastrear se um pedido trocou de entregador
CREATE TABLE IF NOT EXISTS food_dispatch_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  deliverer_id    UUID NOT NULL REFERENCES food_deliverers(id) ON DELETE CASCADE,
  commission_calc NUMERIC(10,2) NOT NULL DEFAULT 0,
  action          TEXT NOT NULL DEFAULT 'assigned' -- assigned | unassigned | delivered
    CHECK (action IN ('assigned','unassigned','delivered')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. ÍNDICES ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_food_deliverers_company  ON food_deliverers(company_id);
CREATE INDEX IF NOT EXISTS idx_food_orders_deliverer    ON food_orders(deliverer_id);
CREATE INDEX IF NOT EXISTS idx_food_dispatch_deliverer  ON food_dispatch_log(deliverer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_food_dispatch_order      ON food_dispatch_log(order_id);

-- ── 5. RLS ───────────────────────────────────────────────────
ALTER TABLE food_deliverers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_dispatch_log ENABLE ROW LEVEL SECURITY;
