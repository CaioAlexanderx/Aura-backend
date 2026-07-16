-- ============================================================
-- 176_studio_version_db_objects.sql
-- Onda 1 · 1.1 — Versiona objetos Studio-core que existiam SO no banco
-- (aplicados direto em prod, nunca commitados como migration numerada).
--
-- Idempotente e SEM mudanca de comportamento. Captado verbatim de
-- pg_get_functiondef / pg_get_triggerdef. Validado offline com pglast.
--
-- Versionado aqui:
--   1. sale_items.customization (jsonb)            -- nao-versionada
--   2. sales.studio_production_status (text)        -- nao-versionada
--      (digital_order_items.customization ja vem da 134; mantido com
--       IF NOT EXISTS so por simetria/idempotencia)
--   3. fn_sales_studio_production_status / trg_sales_studio_status
--      (AFTER INSERT em sale_items -> marca sales.studio_production_status
--       ='pending_art' quando o produto eh personalizavel)
--
-- DEFERIDO de proposito (NAO entram aqui):
--   - fn_studio_consume_inputs_digital / trg_studio_consume_inputs_digital:
--     JA versionados nas migrations 134 e 135.
--   - view studio_orders: depende de marketplace_orders (+ connection_id,
--     marketplace_connections, colunas studio_* em marketplace_orders) que
--     formam um subsistema de Marketplaces ainda NAO versionado. Versiona-la
--     aqui arrastaria esse subsistema inteiro. Fica para uma migration
--     propria de "versionar Marketplaces" (follow-up registrado no PR).
--
-- Backend NAO roda migrations no boot -> aplicar manualmente (em prod no-op).
-- ============================================================

-- 1. Colunas de personalizacao / status (idempotente) --------------------
ALTER TABLE sale_items          ADD COLUMN IF NOT EXISTS customization jsonb;
ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS customization jsonb;
ALTER TABLE sales               ADD COLUMN IF NOT EXISTS studio_production_status text;

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
