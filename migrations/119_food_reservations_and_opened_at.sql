-- ============================================================
-- AURA. -- Migration 119: Fase 2 Food (Salão completo)
-- 1. Coluna food_tables.opened_at (rastreio de sessão da mesa)
-- 2. Tabela food_reservations (reservas de mesa)
--
-- Aplicar manualmente no Supabase SQL Editor.
-- Idempotente: pode rodar várias vezes sem efeito colateral.
-- ============================================================

-- ── 1. SESSÃO DA MESA ──────────────────────────────
-- opened_at: quando mesa foi ocupada pela primeira vez na sessão atual.
-- NULL = mesa livre. Backend (foodOrders.js) set/clear:
--   POST /food/orders com table_id e mesa.opened_at IS NULL → set NOW()
--   PATCH /food/orders/:oid/status delivered/cancelled libera → clear NULL
-- Usado por GET /food/tables/:id/comanda pra filtrar pedidos da sessão
-- atual (sem pegar pedidos antigos delivered de sessões já fechadas).
ALTER TABLE food_tables
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;

-- Backfill: mesas atualmente 'occupied' herdam opened_at = MIN created_at
-- dos pedidos não-cancelados da mesa.
UPDATE food_tables ft
SET opened_at = (
  SELECT MIN(fo.created_at) FROM food_orders fo
  WHERE fo.table_id = ft.id AND fo.status != 'cancelled'
)
WHERE ft.status = 'occupied' AND ft.opened_at IS NULL;

-- ── 2. RESERVAS DE MESA ─────────────────────────────
DO $$ BEGIN
  CREATE TYPE food_reservation_status AS ENUM
    ('pending', 'confirmed', 'checked_in', 'cancelled', 'no_show');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS food_reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  table_id        UUID REFERENCES food_tables(id) ON DELETE SET NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   TEXT NOT NULL,
  customer_phone  TEXT,
  party_size      INTEGER NOT NULL DEFAULT 2,
  reservation_at  TIMESTAMPTZ NOT NULL,
  duration_min    INTEGER NOT NULL DEFAULT 90,
  status          food_reservation_status NOT NULL DEFAULT 'confirmed',
  notes           TEXT,
  created_by      UUID REFERENCES employees(id) ON DELETE SET NULL,
  cancelled_at    TIMESTAMPTZ,
  cancelled_reason TEXT,
  checked_in_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_reservations_company_date
  ON food_reservations(company_id, reservation_at);
CREATE INDEX IF NOT EXISTS idx_food_reservations_table
  ON food_reservations(table_id, reservation_at);
CREATE INDEX IF NOT EXISTS idx_food_reservations_active
  ON food_reservations(company_id, status, reservation_at)
  WHERE status IN ('pending','confirmed','checked_in');

ALTER TABLE food_reservations ENABLE ROW LEVEL SECURITY;
