-- ============================================================
-- 176_studio_version_db_objects.sql
-- Onda 1 · 1.1 — Versiona objetos do Studio que existiam SO no banco
-- (aplicados direto em prod, nunca commitados como migration numerada).
--
-- Idempotente e SEM mudanca de comportamento: em prod isto eh no-op
-- (os objetos ja existem identicos); em ambiente novo, recria-os.
-- Captado verbatim de pg_get_viewdef / pg_get_functiondef / pg_get_triggerdef.
--
-- Objetos versionados:
--   1. sale_items.customization (jsonb) + digital_order_items.customization (jsonb)
--   2. fn_sales_studio_production_status / trg_sales_studio_status
--      (AFTER INSERT em sale_items -> marca sales.studio_production_status='pending_art'
--       quando o produto eh personalizavel)
--   3. fn_studio_consume_inputs_digital / trg_studio_consume_inputs_digital
--      (AFTER INSERT em digital_order_items -> baixa estoque de insumos via composicao)
--   4. view studio_orders (une digital_orders + sales + marketplace_orders do Studio)
--
-- Sem este arquivo, ambiente novo nasce sem esses objetos e o codigo
-- defensivo (fallback rich->slim->raw; 503 MIGRATION_SALE_ITEMS_CUSTOMIZATION_PENDING)
-- entra em acao. Backend NAO roda migrations no boot — aplicar manualmente.
-- ============================================================

-- 1. Colunas de personalizacao (jsonb) -----------------------------------
ALTER TABLE sale_items          ADD COLUMN IF NOT EXISTS customization jsonb;
ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS customization jsonb;

-- 2. sale_items -> sales.studio_production_status -------------------------
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

DROP TRIGGER IF EXISTS trg_sales_studio_status ON public.sale_items;
CREATE TRIGGER trg_sales_studio_status
  AFTER INSERT ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION fn_sales_studio_production_status();

-- 3. digital_order_items -> baixa de insumos (composicao) ----------------
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

DROP TRIGGER IF EXISTS trg_studio_consume_inputs_digital ON public.digital_order_items;
CREATE TRIGGER trg_studio_consume_inputs_digital
  AFTER INSERT ON public.digital_order_items
  FOR EACH ROW EXECUTE FUNCTION fn_studio_consume_inputs_digital();

-- 4. view studio_orders --------------------------------------------------
CREATE OR REPLACE VIEW public.studio_orders AS
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
  WHERE mo.vertical = 'studio'::text AND (COALESCE(mo.status, 'novo'::character varying)::text <> ALL (ARRAY['cancelado'::text, 'cancelled'::text]));
