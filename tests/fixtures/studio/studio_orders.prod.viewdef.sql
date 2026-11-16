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
