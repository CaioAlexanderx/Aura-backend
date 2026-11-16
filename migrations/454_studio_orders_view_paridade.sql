-- ============================================================
-- 454 — View studio_orders: o repositório passa a reproduzir produção (p-126, 16/11/2026)
--
-- A view studio_orders é a única fonte do quadro de Produção. Ela está na
-- migration 208, que só a cria quando o schema deixa. Num banco montado só
-- pelas migrations (CI, staging novo) ela NÃO era criada:
--
--   NOTICE: View studio_orders deferida (schema incompatível neste
--   ambiente): column mo.studio_production_status_override does not exist
--
-- Faltavam no repositório quatro colunas de marketplace_orders que existem
-- em produção (criadas à mão na época do Marketplaces S-0) e dois índices.
-- O teste __tests__/studioOrdersView.paridade.banco.test.js acusou.
--
-- O que esta migration faz:
--   1. cria as quatro colunas, com o tipo e o default de produção;
--   2. cria os dois índices parciais de produção;
--   3. cria a view, com a MESMA definição da 208, quando ela não existe.
--
-- Em produção é tudo no-op: as colunas, os índices e a view já existem
-- (conferido em 16/11/2026 por information_schema, pg_indexes e
-- pg_get_viewdef, só leitura). Idempotente.
--
-- Sem bloco EXCEPTION de propósito: se a view não puder ser criada, a
-- migration falha em voz alta em vez de deferir calada, que foi como a
-- diferença ficou escondida desde a 208.
--
-- Quem mudar a view: migration nova (DROP VIEW + CREATE VIEW, porque
-- CREATE OR REPLACE não troca tipo de coluna) e o retrato em
-- tests/fixtures/studio/ atualizado no mesmo PR.
-- ============================================================

-- 1. Colunas de marketplace_orders que só existiam em produção -----------
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS vertical text DEFAULT 'retail';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS customization_collected_at timestamptz;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS customization_data jsonb;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS studio_production_status_override text;

-- 2. Índices parciais de produção ----------------------------------------
CREATE INDEX IF NOT EXISTS idx_mkt_orders_studio_pending
  ON marketplace_orders (company_id, platform, created_at)
  WHERE vertical = 'studio' AND customization_collected_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_mkt_orders_studio_vertical
  ON marketplace_orders (company_id, vertical, status)
  WHERE vertical = 'studio';

-- 3. A view, só quando não existe (em produção já existe) -----------------
DO $$
BEGIN
  IF to_regclass('public.studio_orders') IS NULL THEN
    EXECUTE $v$
CREATE VIEW studio_orders AS
 SELECT d.id,
    d.company_id,
    d.created_at,
    d.updated_at,
    d.total::numeric(12,2) AS total_amount,
    d.status::text AS status,
    d.studio_production_status::text AS studio_production_status,
    d.customer_name::text AS customer_name,
    d.customer_phone::text AS customer_phone,
    COALESCE(d.order_number::text, 'DO-'::text || "left"(d.id::text, 8)) AS display_name,
    'digital'::text AS source,
    d.id AS digital_order_id,
    NULL::uuid AS pdv_sale_id,
    d.studio_bulk_event_id,
    NULL::uuid AS marketplace_order_id,
    NULL::text AS marketplace_platform,
    NULL::timestamp with time zone AS customization_collected_at
   FROM digital_orders d
  WHERE d.vertical::text = 'studio'::text
UNION ALL
 SELECT s.id,
    s.company_id,
    s.created_at,
    s.updated_at,
    s.total_amount,
    s.status::text AS status,
    s.studio_production_status::text AS studio_production_status,
    cu.name::text AS customer_name,
    cu.phone::text AS customer_phone,
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
  WHERE s.studio_production_status IS NOT NULL AND COALESCE(s.status::text, 'completed') <> 'cancelled'
UNION ALL
 SELECT mo.id,
    mo.company_id,
    mo.created_at,
    mo.updated_at,
    mo.total::numeric(12,2) AS total_amount,
    mo.status::text AS status,
    COALESCE(mo.studio_production_status_override::text,
        CASE
            WHEN mo.customization_collected_at IS NULL THEN 'awaiting_customization'::text
            ELSE 'pending_art'::text
        END) AS studio_production_status,
    mo.customer_name::text AS customer_name,
    NULL::text AS customer_phone,
        CASE mo.platform::text
            WHEN 'mercado_livre' THEN 'ML-'::text || COALESCE(mo.external_id::text, "left"(mo.id::text, 8))
            WHEN 'shopee' THEN 'SHOP-'::text || COALESCE(mo.external_id::text, "left"(mo.id::text, 8))
            ELSE 'MKT-'::text || COALESCE(mo.external_id::text, "left"(mo.id::text, 8))
        END AS display_name,
    'marketplace'::text AS source,
    NULL::uuid AS digital_order_id,
    NULL::uuid AS pdv_sale_id,
    NULL::uuid AS studio_bulk_event_id,
    mo.id AS marketplace_order_id,
    mo.platform::text AS marketplace_platform,
    mo.customization_collected_at
   FROM marketplace_orders mo
  WHERE mo.vertical::text = 'studio'::text AND (COALESCE(mo.status::text, 'novo') <> ALL (ARRAY['cancelado'::text, 'cancelled'::text]))
$v$;
  ELSE
    RAISE NOTICE 'View studio_orders já existe: mantida como está';
  END IF;
END $$;
