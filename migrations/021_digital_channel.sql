-- ============================================================
-- AURA. Migration 021 — Digital Channel Config
-- Mini-site/storefront configuration per company
-- ============================================================

CREATE TABLE IF NOT EXISTS digital_channel_config (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  site_name            VARCHAR(100),
  tagline              VARCHAR(200),
  primary_color        VARCHAR(10) DEFAULT '#7c3aed',
  secondary_color      VARCHAR(10) DEFAULT '#a78bfa',
  logo_url             TEXT,
  cover_url            TEXT,
  description          TEXT,
  address              TEXT,
  phone                VARCHAR(20),
  whatsapp             VARCHAR(20),
  instagram            VARCHAR(60),
  google_maps_url      TEXT,
  business_hours       JSONB DEFAULT '{}'::jsonb,
  featured_product_ids JSONB DEFAULT '[]'::jsonb,
  show_prices          BOOLEAN DEFAULT true,
  show_stock           BOOLEAN DEFAULT false,
  delivery_enabled     BOOLEAN DEFAULT false,
  delivery_fee         NUMERIC(10,2) DEFAULT 0,
  delivery_radius_km   INTEGER DEFAULT 5,
  pickup_enabled       BOOLEAN DEFAULT true,
  is_published         BOOLEAN DEFAULT false,
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digital_channel_company ON digital_channel_config(company_id);
