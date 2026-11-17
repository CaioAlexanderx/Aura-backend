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
$function$
