-- ============================================================
-- 459 — Pedido separado de venda, guardado no Caixa (B1 / p-61a, 17/11/2026)
--
-- O Caixa passa a guardar a venda como PEDIDO: as pecas ficam separadas
-- para a cliente buscar depois. O pedido mora em digital_orders, com
-- origem = 'balcao' (a coluna e da 313). Regras do Caio (17/11):
--   - pedido nao e venda: nao baixa estoque nem caixa ate concluir, so
--     reserva (a reserva e calculada, card B2);
--   - a venda so nasce na conclusao (POST /pdv/sale com order_id, card B5a).
--
-- Colunas (todas anulaveis, nenhuma linha existente muda):
--   digital_orders.promised_date  dia combinado para a cliente buscar
--   digital_orders.sale_id        venda que concluiu o pedido (B5a)
--   digital_orders.created_by     usuario que guardou o pedido no Caixa
--   sales.order_id                pedido que a venda concluiu (B5a)
--
-- Indices parciais: so os pedidos do balcao (lista da aba Pedidos, B3) e so
-- as vendas que concluiram pedido. Os pedidos de hoje nao entram neles.
--
-- Insumos do Studio: o trigger trg_studio_consume_inputs_digital desconta
-- o insumo de toda linha nova de digital_order_items cujo produto tem
-- composicao ativa. No pedido do balcao quem desconta e a VENDA da
-- conclusao (trg_studio_consume_inputs_sale); descontar tambem aqui seria
-- baixar duas vezes, e o cancelamento do balcao (vertical NULL) nao
-- devolveria. A funcao abaixo e a da 357 (a que esta em producao, conferida
-- em 17/11) com UMA linha a mais: pedido de origem 'balcao' nao desconta.
-- Para todo outro pedido o comportamento e o mesmo de hoje.
--
-- digital_orders nasce em src/migrations/043 (legado) em producao e na 070
-- no CI: tudo guardado por to_regclass, como a 313. variant_id e
-- variant_label de digital_order_items ja existem em producao (legado);
-- entram aqui com IF NOT EXISTS para o banco do CI ter as mesmas colunas.
--
-- Idempotente. Sem dado de cliente final.
-- Caminho de volta (depois de reverter o PR do backend):
--   DROP INDEX IF EXISTS idx_digital_orders_balcao;
--   DROP INDEX IF EXISTS idx_sales_order_id;
--   ALTER TABLE digital_orders DROP COLUMN IF EXISTS promised_date,
--     DROP COLUMN IF EXISTS sale_id, DROP COLUMN IF EXISTS created_by;
--   ALTER TABLE sales DROP COLUMN IF EXISTS order_id;
--   e recriar fn_studio_consume_inputs_digital com o texto da 357.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.digital_orders') IS NOT NULL THEN
    ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS origem TEXT;
    ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS promised_date DATE;
    ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS sale_id UUID;
    ALTER TABLE digital_orders ADD COLUMN IF NOT EXISTS created_by UUID;

    COMMENT ON COLUMN digital_orders.promised_date IS
      'Pedido do balcao (origem=balcao): dia combinado para a cliente buscar. NULL = sem data.';
    COMMENT ON COLUMN digital_orders.sale_id IS
      'Venda (sales.id) que concluiu o pedido do balcao. Sem FK de proposito (tabela legada, ver a 313).';
    COMMENT ON COLUMN digital_orders.created_by IS
      'Usuario que guardou o pedido no Caixa (pedido do balcao). NULL nos pedidos da loja online.';

    CREATE INDEX IF NOT EXISTS idx_digital_orders_balcao
      ON digital_orders (company_id, status, promised_date)
      WHERE origem = 'balcao';
  END IF;

  IF to_regclass('public.digital_order_items') IS NOT NULL THEN
    ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS variant_id UUID;
    ALTER TABLE digital_order_items ADD COLUMN IF NOT EXISTS variant_label TEXT;
  END IF;

  IF to_regclass('public.sales') IS NOT NULL THEN
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS order_id UUID;
    COMMENT ON COLUMN sales.order_id IS
      'Pedido do balcao (digital_orders.id, origem=balcao) que esta venda concluiu. NULL = venda comum.';
    CREATE INDEX IF NOT EXISTS idx_sales_order_id
      ON sales (order_id)
      WHERE order_id IS NOT NULL;
  END IF;
END $$;

-- Texto da 357 + o curto-circuito do pedido do balcao.
CREATE OR REPLACE FUNCTION public.fn_studio_consume_inputs_digital()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.product_id IS NULL OR COALESCE(NEW.quantity, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  -- 459: o pedido do balcao nao desconta insumo; a venda da conclusao desconta.
  IF EXISTS (SELECT 1 FROM digital_orders d WHERE d.id = NEW.order_id AND d.origem = 'balcao') THEN
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

COMMENT ON FUNCTION public.fn_studio_consume_inputs_digital() IS
  'Studio: desconta stock_qty dos studio_inputs ao inserir digital_order_items (qty_multiplier_by_option pela customization). Pedido do balcao (origem=balcao) nao desconta: quem desconta e a venda da conclusao (migration 459).';
