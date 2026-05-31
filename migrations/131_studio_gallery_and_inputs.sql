-- ============================================================
-- AURA Studio — Fase 2 (Galeria) + Fase 3 (Insumos/Composições)
-- 24/05/2026
--
-- Fase 2: galeria de templates pré-aprovados que o cliente final
-- usa no storefront sem precisar enviar arte.
--
-- Fase 3: matéria-prima (insumos) consumida por produto-final.
-- Plano B do backlog — tabelas próprias do Studio (NÃO generaliza
-- recipes do Food pra não arriscar produção). Pode unificar depois.
-- ============================================================

CREATE TABLE IF NOT EXISTS studio_template_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  icon        TEXT DEFAULT NULL,
  color       TEXT DEFAULT NULL,
  sort_order  INT  NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_studio_tpl_cat_company
  ON studio_template_categories (company_id, is_active, sort_order);

CREATE TABLE IF NOT EXISTS studio_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_id  UUID DEFAULT NULL REFERENCES studio_template_categories(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  description  TEXT DEFAULT NULL,
  image_url    TEXT NOT NULL,
  thumb_url    TEXT DEFAULT NULL,
  tags         TEXT[] DEFAULT '{}'::text[],
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  use_count    INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by   UUID DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_tpl_company
  ON studio_templates (company_id, is_active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_tpl_category
  ON studio_templates (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_studio_tpl_tags
  ON studio_templates USING GIN (tags);

CREATE TABLE IF NOT EXISTS studio_product_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id  UUID DEFAULT NULL REFERENCES products(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES studio_templates(id) ON DELETE CASCADE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, product_id, template_id)
);
CREATE INDEX IF NOT EXISTS idx_studio_ptpl_product
  ON studio_product_templates (company_id, product_id, sort_order)
  WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_studio_ptpl_global
  ON studio_product_templates (company_id, sort_order)
  WHERE product_id IS NULL;

CREATE TABLE IF NOT EXISTS studio_inputs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  unit            TEXT NOT NULL DEFAULT 'un',
  unit_cost       NUMERIC(12,4) NOT NULL DEFAULT 0,
  stock_qty       NUMERIC(12,3) NOT NULL DEFAULT 0,
  stock_min       NUMERIC(12,3) DEFAULT NULL,
  supplier_name   TEXT DEFAULT NULL,
  supplier_phone  TEXT DEFAULT NULL,
  notes           TEXT DEFAULT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      UUID DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_inputs_company
  ON studio_inputs (company_id, is_active, name);
CREATE INDEX IF NOT EXISTS idx_studio_inputs_low
  ON studio_inputs (company_id)
  WHERE is_active = TRUE AND stock_min IS NOT NULL AND stock_qty < stock_min;

CREATE TABLE IF NOT EXISTS studio_compositions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  notes       TEXT DEFAULT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_studio_comp_company
  ON studio_compositions (company_id, is_active);

CREATE TABLE IF NOT EXISTS studio_composition_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  composition_id  UUID NOT NULL REFERENCES studio_compositions(id) ON DELETE CASCADE,
  input_id        UUID NOT NULL REFERENCES studio_inputs(id) ON DELETE RESTRICT,
  qty_per_unit    NUMERIC(12,4) NOT NULL CHECK (qty_per_unit > 0),
  notes           TEXT DEFAULT NULL,
  sort_order      INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (composition_id, input_id)
);
CREATE INDEX IF NOT EXISTS idx_studio_comp_items_comp
  ON studio_composition_items (composition_id, sort_order);

CREATE OR REPLACE VIEW studio_compositions_summary AS
SELECT
  c.id                AS composition_id,
  c.company_id,
  c.product_id,
  p.name              AS product_name,
  p.price             AS product_price,
  COALESCE(SUM(ci.qty_per_unit * i.unit_cost), 0)::numeric(12,2) AS total_cost,
  CASE
    WHEN p.price IS NULL OR p.price = 0 THEN NULL
    ELSE ((p.price - COALESCE(SUM(ci.qty_per_unit * i.unit_cost), 0)) / p.price * 100)::numeric(5,2)
  END                 AS margin_pct,
  COUNT(ci.id)        AS item_count,
  c.is_active
FROM studio_compositions c
LEFT JOIN products                    p  ON p.id = c.product_id
LEFT JOIN studio_composition_items    ci ON ci.composition_id = c.id
LEFT JOIN studio_inputs               i  ON i.id = ci.input_id
GROUP BY c.id, c.company_id, c.product_id, p.name, p.price, c.is_active;
