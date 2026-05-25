-- ============================================================
-- AURA Studio — Fase 6 (Bulk events) + Fase 7 (Hub KPIs)
-- 25/05/2026
-- ============================================================

CREATE TABLE IF NOT EXISTS studio_bulk_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_name          TEXT NOT NULL,
  event_date          DATE DEFAULT NULL,
  customer_name       TEXT DEFAULT NULL,
  customer_phone      TEXT DEFAULT NULL,
  customer_email      TEXT DEFAULT NULL,
  product_id          UUID DEFAULT NULL REFERENCES products(id) ON DELETE SET NULL,
  product_name_snapshot TEXT DEFAULT NULL,
  base_unit_price     NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_qty           INT NOT NULL DEFAULT 0,
  total_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount_pct        NUMERIC(5,2) NOT NULL DEFAULT 0,
  delivery_deadline   DATE DEFAULT NULL,
  notes               TEXT DEFAULT NULL,
  status              TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'confirmed', 'in_production', 'delivered', 'cancelled')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_bulk_company
  ON studio_bulk_events (company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_bulk_deadline
  ON studio_bulk_events (company_id, delivery_deadline)
  WHERE delivery_deadline IS NOT NULL AND status IN ('confirmed', 'in_production');

CREATE TABLE IF NOT EXISTS studio_bulk_event_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES studio_bulk_events(id) ON DELETE CASCADE,
  line_number     INT NOT NULL,
  recipient_name  TEXT DEFAULT NULL,
  customization   JSONB DEFAULT NULL,
  notes           TEXT DEFAULT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, line_number)
);
CREATE INDEX IF NOT EXISTS idx_studio_bulk_items_event
  ON studio_bulk_event_items (event_id, line_number);

ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS studio_bulk_event_id UUID
    REFERENCES studio_bulk_events(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_digital_orders_bulk_event
  ON digital_orders (studio_bulk_event_id)
  WHERE studio_bulk_event_id IS NOT NULL;

CREATE OR REPLACE VIEW studio_hub_kpis AS
SELECT
  company_id,
  COUNT(*) FILTER (WHERE studio_production_status = 'pending_art')   AS pending_art_count,
  COUNT(*) FILTER (WHERE studio_production_status = 'approved')      AS approved_count,
  COUNT(*) FILTER (WHERE studio_production_status = 'in_production') AS in_production_count,
  COUNT(*) FILTER (WHERE studio_production_status = 'ready')         AS ready_count,
  COUNT(*) FILTER (WHERE studio_production_status = 'delivered'
                   AND created_at >= CURRENT_DATE - INTERVAL '7 days') AS delivered_7d,
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')    AS orders_7d,
  COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)                 AS orders_today,
  COALESCE(SUM(total) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::numeric(12,2) AS revenue_7d,
  COALESCE(SUM(total) FILTER (WHERE created_at >= CURRENT_DATE), 0)::numeric(12,2) AS revenue_today,
  COUNT(*) FILTER (WHERE studio_production_status NOT IN ('delivered','ready')
                   AND created_at < NOW() - INTERVAL '3 days') AS overdue_count,
  COUNT(*) FILTER (WHERE status != 'cancelled') AS total_orders
FROM digital_orders
WHERE vertical = 'studio'
GROUP BY company_id;
