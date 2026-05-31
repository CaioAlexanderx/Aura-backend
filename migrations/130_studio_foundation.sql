-- ============================================================
-- AURA Studio — Foundation (Fase 0 + Fase 1)
-- 24/05/2026
-- Vertical novo de personalizados. Piloto Sheid Mania.
-- Doc: Projects/Aura/BACKLOG_AURA_STUDIO.md
-- Memory: plano_aura_studio_vertical_24mai2026
-- ============================================================

-- ── Companies: settings dedicados do Studio ───────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS studio_settings JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN companies.studio_settings IS
  'Configurações do vertical Aura Studio (personalizados): default_print_area, fonts, gallery_categories, sla_days etc';

-- ── pdv_settings: novos toggles (idempotente) ─────────────────
-- Segue padrão da memory toggles_pdv_settings: novos flags vivem dentro
-- do JSONB existente pra não precisar de migration nova quando adicionar
-- mais toggles depois.
UPDATE companies
SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb)
                || jsonb_build_object(
                     'studio_enabled',          COALESCE(pdv_settings->'studio_enabled', 'false'::jsonb),
                     'studio_kds_enabled',      COALESCE(pdv_settings->'studio_kds_enabled', 'false'::jsonb),
                     'studio_gallery_enabled',  COALESCE(pdv_settings->'studio_gallery_enabled', 'false'::jsonb),
                     'studio_approval_enabled', COALESCE(pdv_settings->'studio_approval_enabled', 'false'::jsonb),
                     'studio_approval_mode',    COALESCE(pdv_settings->'studio_approval_mode', '"wa_me"'::jsonb)
                   );

-- ── Products: campos de personalização (dormente até Fase 1 ligar) ──
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_personalizable    BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS customization_config JSONB  DEFAULT NULL;

COMMENT ON COLUMN products.is_personalizable IS
  'Studio: produto aceita personalização do cliente (texto/upload/galeria)';

COMMENT ON COLUMN products.customization_config IS
  'Studio: schema da config — { print_area: {width_cm, height_cm, position}, fields: [{id, type, label, required, config}] }';

CREATE INDEX IF NOT EXISTS idx_products_personalizable
  ON products (company_id, is_personalizable)
  WHERE is_personalizable = TRUE;

-- ── Cart items: customização salva pelo cliente ───────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'cart_items') THEN
    EXECUTE 'ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS customization JSONB DEFAULT NULL';
    EXECUTE $cmt$COMMENT ON COLUMN cart_items.customization IS
      'Studio: configuração preenchida pelo cliente — { fields: [{id, value}], preview_url }'$cmt$;
  END IF;
END $$;

-- ── Digital orders: vertical + customização preservada por item ─────
ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS vertical TEXT DEFAULT NULL
    CHECK (vertical IS NULL OR vertical IN ('retail','food','studio'));

COMMENT ON COLUMN digital_orders.vertical IS
  'Aura Studio: separa pedidos por vertical pra Hub/KDS filtrar. NULL = legado/retail.';

CREATE INDEX IF NOT EXISTS idx_digital_orders_vertical
  ON digital_orders (company_id, vertical, created_at DESC)
  WHERE vertical IS NOT NULL;

ALTER TABLE digital_order_items
  ADD COLUMN IF NOT EXISTS customization JSONB DEFAULT NULL;

COMMENT ON COLUMN digital_order_items.customization IS
  'Studio: snapshot da personalização do cliente no momento do pedido (texto, arte, template escolhido)';

-- ── Production status (Studio) ────────────────────────────────
ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS studio_production_status TEXT DEFAULT NULL
    CHECK (studio_production_status IS NULL OR studio_production_status IN
      ('pending_art','approved','in_production','ready','delivered'));

CREATE INDEX IF NOT EXISTS idx_digital_orders_studio_prod
  ON digital_orders (company_id, studio_production_status)
  WHERE studio_production_status IS NOT NULL;
