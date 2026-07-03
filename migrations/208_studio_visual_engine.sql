-- ============================================================
-- 208 — Aura Studio · Visual Engine (F0)
--
-- Fundação de dados da visualização de produtos (2D HD + 3D):
--   1. studio_visual_templates  — templates visuais globais mantidos pela
--      Aura (sem company_id). kind: photo2d (foto HD + warp/sombras por
--      vista frente/verso) | model3d (GLB + áreas UV painel/wrap).
--      Geometria/assets ficam em spec JSONB, versionado por `version`.
--   2. studio_visual_renders   — cada render gerado (preview, HD 2D,
--      snapshot 3D, vídeo turntable) com snapshot da customização e
--      content_hash = prova do "foi isso que você aprovou".
--   3. studio_approvals        — aprovação formal com token público
--      (hash), integrada à política de revisões do studio_settings.
--      F2 consome; F0 só cria o schema.
--   4. products.visual_template_key — vínculo produto → template (soft
--      reference por key; sem FK pra não travar CI/seed).
--   5. Quitação da pendência 1.1 do BACKLOG_ENG_STUDIO_PREMIUM:
--      versiona objetos que existiam só em prod — coluna
--      sale_items.customization, funções/triggers studio de consumo de
--      insumos e a view studio_orders (guardada por to_regclass: em
--      banco sem o subsistema marketplaces a view fica deferida, mesmo
--      comportamento defensivo do código hoje).
--
-- Idempotente: IF NOT EXISTS / CREATE OR REPLACE / guards em DO $$.
-- Aplicar via Supabase MCP antes do merge (padrão da casa).
-- ============================================================

-- ── 1. Templates visuais globais ────────────────────────────
CREATE TABLE IF NOT EXISTS studio_visual_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('photo2d','model3d')),
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version    INTEGER NOT NULL DEFAULT 1,
  spec       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_svt_status_kind
  ON studio_visual_templates (status, kind);

-- ── 2. Renders / artefatos ──────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_visual_renders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  template_key          TEXT NOT NULL,
  template_version      INTEGER NOT NULL DEFAULT 1,
  sale_item_id          UUID,
  digital_order_item_id UUID,
  kind                  TEXT NOT NULL CHECK (kind IN ('preview','hd_2d','snapshot_3d','turntable_video')),
  customization         JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_hash          TEXT NOT NULL,
  file_url              TEXT,
  file_key              TEXT,
  content_type          TEXT,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_svr_company
  ON studio_visual_renders (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_svr_sale_item
  ON studio_visual_renders (sale_item_id) WHERE sale_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_svr_doi
  ON studio_visual_renders (digital_order_item_id) WHERE digital_order_item_id IS NOT NULL;

-- ── 3. Aprovações (schema; fluxo entra na F2) ───────────────
CREATE TABLE IF NOT EXISTS studio_approvals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_item_id          UUID,
  digital_order_item_id UUID,
  render_ids            UUID[] NOT NULL DEFAULT '{}',
  public_token_hash     TEXT NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','change_requested','expired','cancelled')),
  revision_number       INTEGER NOT NULL DEFAULT 1,
  customer_note         TEXT,
  decided_at            TIMESTAMPTZ,
  expires_at            TIMESTAMPTZ,
  created_by            UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sap_company
  ON studio_approvals (company_id, status, created_at DESC);

-- ── 4. Vínculo produto → template ───────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS visual_template_key TEXT;

-- ── 5. Quitação pendência 1.1 — versionar objetos de prod ───

-- 5a. Coluna sale_items.customization (migration studio_sale_items_customization
--     aplicada direto em prod na Sub-onda E, 25/05/2026)
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS customization JSONB;

-- 5b. Funções studio (defs extraídas de prod em 02/07/2026)
CREATE OR REPLACE FUNCTION public.fn_sales_studio_production_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM products p
     WHERE p.id = NEW.product_id
       AND p.is_personalizable = true
  ) THEN
    UPDATE sales
       SET studio_production_status = 'pending_art'
     WHERE id = NEW.sale_id
       AND studio_production_status IS NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_studio_consume_inputs_sale()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM products p
     WHERE p.id = NEW.product_id
       AND p.is_personalizable = true
  ) THEN
    UPDATE studio_inputs i
       SET stock_qty  = i.stock_qty - (ci.qty_per_unit * NEW.quantity),
           updated_at = NOW()
      FROM studio_composition_items ci
      JOIN studio_compositions c ON c.id = ci.composition_id
     WHERE c.product_id = NEW.product_id
       AND c.is_active = true
       AND ci.input_id = i.id
       AND i.company_id = c.company_id
       AND i.is_active = true;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_studio_restore_inputs_sale_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- So devolve se mudou pra cancelled e antes nao era
  IF (OLD.status IS DISTINCT FROM 'cancelled')
     AND NEW.status = 'cancelled'
  THEN
    UPDATE studio_inputs i
       SET stock_qty  = i.stock_qty + (ci.qty_per_unit * si.quantity),
           updated_at = NOW()
      FROM sale_items si
      JOIN products p                  ON p.id = si.product_id
      JOIN studio_compositions c       ON c.product_id = p.id
                                      AND c.is_active = true
      JOIN studio_composition_items ci ON ci.composition_id = c.id
     WHERE si.sale_id = NEW.id
       AND p.is_personalizable = true
       AND ci.input_id = i.id
       AND i.company_id = c.company_id
       AND i.is_active = true;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_studio_consume_inputs_digital()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.product_id IS NULL OR COALESCE(NEW.quantity, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  UPDATE studio_inputs si
     SET stock_qty = stock_qty - (
           ci.qty_per_unit * NEW.quantity * COALESCE(
             (
               SELECT MIN(
                        ((ci.qty_multiplier_by_option -> kv.key) ->> (NEW.customization ->> kv.key))::numeric
                      )
                 FROM jsonb_object_keys(COALESCE(ci.qty_multiplier_by_option, '{}'::jsonb)) AS kv(key)
                WHERE NEW.customization IS NOT NULL
                  AND NEW.customization ? kv.key
                  AND (ci.qty_multiplier_by_option -> kv.key) ? (NEW.customization ->> kv.key)
                  AND jsonb_typeof((ci.qty_multiplier_by_option -> kv.key) -> (NEW.customization ->> kv.key)) = 'number'
             ),
             1
           )
         ),
         updated_at = NOW()
    FROM studio_composition_items ci
    JOIN studio_compositions      c  ON c.id = ci.composition_id
   WHERE c.product_id  = NEW.product_id
     AND c.is_active   = TRUE
     AND si.id         = ci.input_id
     AND si.company_id = c.company_id;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_studio_restore_inputs_digital_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (OLD.status IS DISTINCT FROM 'cancelled')
     AND NEW.status = 'cancelled'
     AND NEW.vertical = 'studio'
  THEN
    UPDATE studio_inputs i
       SET stock_qty  = stock_qty + (ci.qty_per_unit * doi.quantity),
           updated_at = NOW()
      FROM digital_order_items doi
      JOIN products p                 ON p.id = doi.product_id
      JOIN studio_compositions c      ON c.product_id = p.id
                                     AND c.is_active = true
      JOIN studio_composition_items ci ON ci.composition_id = c.id
     WHERE doi.order_id = NEW.id
       AND p.is_personalizable = true
       AND ci.input_id = i.id
       AND i.company_id = c.company_id
       AND i.is_active = true;
  END IF;
  RETURN NEW;
END;
$function$;

-- 5c. Triggers (guardados: só cria se a tabela existe e o trigger não)
DO $$
BEGIN
  IF to_regclass('public.sale_items') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sales_studio_status'
  ) THEN
    CREATE TRIGGER trg_sales_studio_status
      AFTER INSERT ON public.sale_items
      FOR EACH ROW EXECUTE FUNCTION fn_sales_studio_production_status();
  END IF;

  IF to_regclass('public.sale_items') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_studio_consume_inputs_sale'
  ) THEN
    CREATE TRIGGER trg_studio_consume_inputs_sale
      AFTER INSERT ON public.sale_items
      FOR EACH ROW EXECUTE FUNCTION fn_studio_consume_inputs_sale();
  END IF;

  IF to_regclass('public.sales') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_studio_restore_inputs_sale_cancel'
  ) THEN
    CREATE TRIGGER trg_studio_restore_inputs_sale_cancel
      AFTER UPDATE OF status ON public.sales
      FOR EACH ROW EXECUTE FUNCTION fn_studio_restore_inputs_sale_cancel();
  END IF;

  IF to_regclass('public.digital_order_items') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_studio_consume_inputs_digital'
  ) THEN
    CREATE TRIGGER trg_studio_consume_inputs_digital
      AFTER INSERT ON public.digital_order_items
      FOR EACH ROW EXECUTE FUNCTION fn_studio_consume_inputs_digital();
  END IF;

  IF to_regclass('public.digital_orders') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_studio_restore_inputs_digital_cancel'
  ) THEN
    CREATE TRIGGER trg_studio_restore_inputs_digital_cancel
      AFTER UPDATE OF status ON public.digital_orders
      FOR EACH ROW EXECUTE FUNCTION fn_studio_restore_inputs_digital_cancel();
  END IF;
EXCEPTION
  WHEN undefined_table OR undefined_column THEN
    RAISE NOTICE 'Triggers studio deferidos (schema incompleto neste ambiente): %', SQLERRM;
END $$;

-- 5d. View studio_orders (def extraída de prod em 02/07/2026).
--     Guardada: exige digital_orders, sales, customers e marketplace_orders
--     (marketplaces ainda não versionado — armadilha conhecida). Em ambiente
--     sem marketplaces a view fica deferida, igual ao comportamento atual.
DO $$
BEGIN
  IF to_regclass('public.digital_orders') IS NOT NULL
     AND to_regclass('public.sales') IS NOT NULL
     AND to_regclass('public.customers') IS NOT NULL
     AND to_regclass('public.marketplace_orders') IS NOT NULL THEN
    BEGIN
      EXECUTE $v$
CREATE OR REPLACE VIEW studio_orders AS
 SELECT d.id,
    d.company_id,
    d.created_at,
    d.updated_at,
    d.total::numeric(12,2) AS total_amount,
    d.status,
    d.studio_production_status,
    d.customer_name,
    d.customer_phone,
    COALESCE(d.order_number, 'DO-'::text || "left"(d.id::text, 8)) AS display_name,
    'digital'::text AS source,
    d.id AS digital_order_id,
    NULL::uuid AS pdv_sale_id,
    d.studio_bulk_event_id,
    NULL::uuid AS marketplace_order_id,
    NULL::text AS marketplace_platform,
    NULL::timestamp with time zone AS customization_collected_at
   FROM digital_orders d
  WHERE d.vertical = 'studio'::text
UNION ALL
 SELECT s.id,
    s.company_id,
    s.created_at,
    s.updated_at,
    s.total_amount,
    s.status,
    s.studio_production_status,
    cu.name AS customer_name,
    cu.phone AS customer_phone,
    'PDV-'::text || "left"(s.id::text, 8) AS display_name,
    'pdv'::text AS source,
    NULL::uuid AS digital_order_id,
    s.id AS pdv_sale_id,
    NULL::uuid AS studio_bulk_event_id,
    NULL::uuid AS marketplace_order_id,
    NULL::text AS marketplace_platform,
    NULL::timestamp with time zone AS customization_collected_at
   FROM sales s
     LEFT JOIN customers cu ON cu.id = s.customer_id
  WHERE s.studio_production_status IS NOT NULL AND COALESCE(s.status, 'completed'::character varying)::text <> 'cancelled'::text
UNION ALL
 SELECT mo.id,
    mo.company_id,
    mo.created_at,
    mo.updated_at,
    mo.total::numeric(12,2) AS total_amount,
    mo.status,
    COALESCE(mo.studio_production_status_override,
        CASE
            WHEN mo.customization_collected_at IS NULL THEN 'awaiting_customization'::text
            ELSE 'pending_art'::text
        END) AS studio_production_status,
    mo.customer_name,
    NULL::text AS customer_phone,
        CASE mo.platform
            WHEN 'mercado_livre'::text THEN 'ML-'::text || COALESCE(mo.external_id, "left"(mo.id::text, 8)::character varying)::text
            WHEN 'shopee'::text THEN 'SHOP-'::text || COALESCE(mo.external_id, "left"(mo.id::text, 8)::character varying)::text
            ELSE 'MKT-'::text || COALESCE(mo.external_id, "left"(mo.id::text, 8)::character varying)::text
        END AS display_name,
    'marketplace'::text AS source,
    NULL::uuid AS digital_order_id,
    NULL::uuid AS pdv_sale_id,
    NULL::uuid AS studio_bulk_event_id,
    mo.id AS marketplace_order_id,
    mo.platform::text AS marketplace_platform,
    mo.customization_collected_at
   FROM marketplace_orders mo
  WHERE mo.vertical = 'studio'::text AND (COALESCE(mo.status, 'novo'::character varying)::text <> ALL (ARRAY['cancelado'::text, 'cancelled'::text]))
$v$;
    EXCEPTION
      WHEN undefined_table OR undefined_column THEN
        RAISE NOTICE 'View studio_orders deferida (schema incompleto neste ambiente): %', SQLERRM;
    END;
  ELSE
    RAISE NOTICE 'View studio_orders deferida: subsistema marketplaces ausente neste ambiente';
  END IF;
END $$;
