-- ============================================================
-- AURA Studio — Fix: cancelar pedido da vitrine Studio dava 500
-- 28/09/2026 — QA pos-deploy da vitrine (LJ-33, P0)
--
-- # Sintoma
--
-- POST /digital-channel/orders/:oid/reject-payment ("Recusar pagamento")
-- respondia 500 em toda tentativa. O log do Postgres, no mesmo minuto:
--   ERROR 42702: column reference "stock_qty" is ambiguous
--
-- # Causa raiz
--
-- E o MESMO bug da migration 135, que voltou pela 208. A 135 corrigiu a
-- funcao do PDV (fn_studio_restore_inputs_sale_cancel) qualificando o RHS
-- do UPDATE com o alias do alvo (i.stock_qty). A 208 recriou a funcao
-- IRMA do canal digital com o RHS sem alias:
--
--   UPDATE studio_inputs i
--      SET stock_qty = stock_qty + (...)      <- RHS ambiguo
--     FROM digital_order_items doi
--     JOIN products p ...                     <- products tambem tem stock_qty
--
-- O trigger trg_studio_restore_inputs_digital_cancel roda em todo UPDATE
-- de status para 'cancelled' de pedido com vertical = 'studio'. Entao
-- TODO cancelamento de pedido da vitrine Studio falhava, por qualquer
-- caminho: "Recusar pagamento", PATCH /status 'cancelled' e o job de Pix
-- vencido (jobs/lojaPixExpiradoJob.js), que cancela em lote — um pedido
-- Studio no lote derrubava o UPDATE inteiro, das outras lojas tambem.
--
-- # Fix
--
-- Qualificar o RHS (i.stock_qty), como na 135. A irma que desconta o
-- insumo ao criar o item (fn_studio_consume_inputs_digital) recebe a
-- mesma higiene: a 208 tambem tirou o alias dela, e hoje so nao quebra
-- porque o FROM dela nao tem products.
--
-- # Reproducao (SQL)
--
--   BEGIN;
--   UPDATE digital_orders SET status = 'cancelled' WHERE id = '<pedido studio>';
--   -- antes: ERROR 42702 / depois: UPDATE 1
--   ROLLBACK;
-- ============================================================

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
       SET stock_qty  = i.stock_qty + (ci.qty_per_unit * doi.quantity),
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

CREATE OR REPLACE FUNCTION public.fn_studio_consume_inputs_digital()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.product_id IS NULL OR COALESCE(NEW.quantity, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  UPDATE studio_inputs si
     SET stock_qty = si.stock_qty - (
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

COMMENT ON FUNCTION public.fn_studio_restore_inputs_digital_cancel() IS
  'Studio: devolve stock_qty dos studio_inputs quando um pedido digital Studio e cancelado. RHS qualificado (i.stock_qty): products.stock_qty no FROM tornava a coluna ambigua (42702) e todo cancelamento dava erro (migration 357, 28/09/2026).';
