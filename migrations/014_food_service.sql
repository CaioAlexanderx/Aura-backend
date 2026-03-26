-- ============================================================
-- AURA. — Migration 014: Módulo Food Service
-- FOOD-00: Arquitetura base (cardápio, pedidos, KDS, delivery)
-- Aplicar manualmente no Supabase SQL Editor
-- ============================================================

-- ── 1. CARDÁPIOS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_menus (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT 'Cardápio',
  slug          TEXT,                        -- URL pública: /cardapio/:slug
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  accepts_online_orders BOOLEAN NOT NULL DEFAULT FALSE,
  min_order_amount NUMERIC(10,2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, slug)
);

-- ── 2. CATEGORIAS DO CARDÁPIO ─────────────────────────────────
CREATE TABLE IF NOT EXISTS food_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id     UUID NOT NULL REFERENCES food_menus(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 3. ITENS DO CARDÁPIO ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id     UUID REFERENCES food_categories(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,
  cost_price      NUMERIC(10,2),             -- calculado da ficha técnica
  photo_url       TEXT,                      -- Cloudflare R2
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_available    BOOLEAN NOT NULL DEFAULT TRUE,
  preparation_time_min INTEGER,              -- tempo de preparo em minutos
  serves          INTEGER DEFAULT 1,         -- porção para quantas pessoas
  sort_order      INTEGER NOT NULL DEFAULT 0,
  tags            TEXT[],                    -- ['vegano','sem_gluten','picante']
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 4. VARIAÇÕES (tamanho, ponto, etc.) ───────────────────────
CREATE TABLE IF NOT EXISTS food_item_variations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     UUID NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                 -- 'P', 'M', 'G' / 'Mal passado', etc.
  price_delta NUMERIC(10,2) NOT NULL DEFAULT 0, -- diferença de preço (+/-)
  is_required BOOLEAN NOT NULL DEFAULT FALSE, -- variação obrigatória?
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── 5. ADICIONAIS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_addons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  item_id     UUID REFERENCES food_items(id) ON DELETE CASCADE, -- null = global
  name        TEXT NOT NULL,
  price       NUMERIC(10,2) NOT NULL DEFAULT 0,
  max_qty     INTEGER DEFAULT 1,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── 6. FICHA TÉCNICA (ingredientes por item) ──────────────────
CREATE TABLE IF NOT EXISTS food_recipes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         UUID NOT NULL REFERENCES food_items(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ingredient_name TEXT NOT NULL,
  unit            TEXT NOT NULL DEFAULT 'un', -- kg, g, l, ml, un, colher_sopa
  quantity        NUMERIC(10,4) NOT NULL,
  unit_cost       NUMERIC(10,4) NOT NULL DEFAULT 0, -- custo por unidade
  -- custo total = quantity * unit_cost (calculado on-read)
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL, -- vínculo com estoque
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 7. MESAS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_tables (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number      TEXT NOT NULL,                 -- '1', '2', 'Varanda 3', etc.
  seats       INTEGER,
  qr_code_url TEXT,                          -- QR para auto-pedido
  status      TEXT NOT NULL DEFAULT 'free'   -- free | occupied | reserved
    CHECK (status IN ('free','occupied','reserved')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(company_id, number)
);

-- ── 8. PEDIDOS ────────────────────────────────────────────────
CREATE TYPE IF NOT EXISTS food_order_channel AS ENUM
  ('presencial','delivery_proprio','ifood','whatsapp','online');

CREATE TYPE IF NOT EXISTS food_order_status AS ENUM
  ('pending','confirmed','preparing','ready','delivered','cancelled');

CREATE TABLE IF NOT EXISTS food_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  table_id        UUID REFERENCES food_tables(id) ON DELETE SET NULL,
  customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
  channel         food_order_channel NOT NULL DEFAULT 'presencial',
  status          food_order_status NOT NULL DEFAULT 'pending',
  subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount        NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_fee    NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  customer_name   TEXT,                      -- para pedidos sem cadastro
  customer_phone  TEXT,
  delivery_address JSONB,                    -- {street, number, complement, neighborhood}
  payment_method  TEXT,
  paid_at         TIMESTAMPTZ,
  confirmed_at    TIMESTAMPTZ,
  ready_at        TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  estimated_ready_at TIMESTAMPTZ,
  waiter_id       UUID REFERENCES employees(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 9. ITENS DO PEDIDO ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_order_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        UUID NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  item_id         UUID REFERENCES food_items(id) ON DELETE SET NULL,
  item_name       TEXT NOT NULL,             -- snapshot do nome no momento do pedido
  variation_name  TEXT,
  quantity        INTEGER NOT NULL DEFAULT 1,
  unit_price      NUMERIC(10,2) NOT NULL,
  total_price     NUMERIC(10,2) NOT NULL,
  addons          JSONB,                     -- [{name, price, qty}]
  notes           TEXT,                      -- observações do cliente
  kds_status      TEXT NOT NULL DEFAULT 'pending'
    CHECK (kds_status IN ('pending','preparing','done'))
);

-- ── 10. EVENTOS KDS (histórico de status) ─────────────────────
CREATE TABLE IF NOT EXISTS food_kds_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_status food_order_status,
  to_status   food_order_status NOT NULL,
  triggered_by UUID REFERENCES employees(id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 11. ZONAS DE ENTREGA ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS food_delivery_zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                 -- 'Centro', 'Zona Sul'
  fee         NUMERIC(10,2) NOT NULL DEFAULT 0,
  min_time_min INTEGER,                      -- tempo mínimo de entrega
  max_time_min INTEGER,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

-- ── 12. ÍNDICES ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_food_items_company     ON food_items(company_id);
CREATE INDEX IF NOT EXISTS idx_food_items_category    ON food_items(category_id);
CREATE INDEX IF NOT EXISTS idx_food_orders_company    ON food_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_food_orders_status     ON food_orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_food_orders_created    ON food_orders(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_food_order_items_order ON food_order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_food_kds_company       ON food_kds_events(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_food_recipes_item      ON food_recipes(item_id);

-- ── 13. RLS (Row Level Security) ──────────────────────────────
ALTER TABLE food_menus            ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_categories       ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_item_variations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_addons           ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_recipes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_tables           ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_orders           ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_order_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_kds_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_delivery_zones   ENABLE ROW LEVEL SECURITY;
