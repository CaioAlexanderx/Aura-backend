-- 137_fix_customer_metrics_trigger.sql
-- Corrige double-count de total_purchases/total_spent.
-- Causa: trigger update_customer_metrics (idempotente, COUNT/SUM) + UPDATE
-- manual no pdv.js incrementavam os mesmos campos -> dobro.
-- Fix: (a) trigger passa a IGNORAR vendas canceladas; (b) dispara tambem em
-- UPDATE OF status, para recalcular quando uma venda e cancelada.
-- O UPDATE manual do pdv.js foi removido no mesmo deploy (commit fdb5d51).
-- 29/05/2026

CREATE OR REPLACE FUNCTION public.update_customer_metrics()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_customer UUID;
BEGIN
  -- Em UPDATE, customer_id pode ter mudado; cobre OLD e NEW.
  target_customer := COALESCE(NEW.customer_id, OLD.customer_id);
  IF target_customer IS NOT NULL THEN
    UPDATE customers SET
      total_purchases  = (SELECT COUNT(*) FROM sales
                            WHERE customer_id = target_customer
                              AND company_id = COALESCE(NEW.company_id, OLD.company_id)
                              AND COALESCE(status, 'completed') != 'cancelled'),
      total_spent      = (SELECT COALESCE(SUM(total_amount), 0) FROM sales
                            WHERE customer_id = target_customer
                              AND company_id = COALESCE(NEW.company_id, OLD.company_id)
                              AND COALESCE(status, 'completed') != 'cancelled'),
      last_purchase_at = NOW(),
      first_purchase_at = LEAST(first_purchase_at, NOW()),
      updated_at       = NOW()
    WHERE id = target_customer;
  END IF;
  RETURN NEW;
END;
$function$;

-- Recria o trigger para disparar em INSERT e em UPDATE OF status.
DROP TRIGGER IF EXISTS trg_sale_update_customer ON sales;
CREATE TRIGGER trg_sale_update_customer
  AFTER INSERT OR UPDATE OF status ON sales
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_metrics();
