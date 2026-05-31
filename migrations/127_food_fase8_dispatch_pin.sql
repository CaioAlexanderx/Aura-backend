-- =========================================================
-- MIGRATION 127 - Fase 8 — Motoboys + Delivery Próprio
-- Dispatch PIN (anti-fraude) + tempos de rota + payout control
--
-- Nota: numeração 127 porque 123-126 já ocupadas por sales_crm_*.
-- Idempotente - IF NOT EXISTS em todos os ALTERs/INDEXes.
-- ==========================================================

-- 127a - PIN entregador (anti-fraude entrega)
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS deliverer_pin     TEXT;
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS pin_verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_food_orders_deliverer_pin
  ON food_orders (deliverer_pin)
  WHERE deliverer_pin IS NOT NULL;

-- 127b - tempos de rota (despacho -> entrega)
-- Nota: food_orders.dispatched_at já existe desde versões anteriores
-- (foodDeliverers.js jSnota usa "COALESCE(dispatched_at, NOW())").
-- O ADD COLUMN IF NOT EXISTS é defensivo caso algum ambiente não tenha.
ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_food_orders_dispatched_at
  ON food_orders (dispatched_at)
  WHERE dispatched_at IS NOT NULL;

-- 127c - comissão paga (controle de payout)
ALTER TABLE food_deliverers
  ADD COLUMN IF NOT EXISTS last_payout_at TIMESTAMPTZ;
