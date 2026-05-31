-- ============================================================
-- AURA Studio — Fix: column reference "stock_qty" is ambiguous
-- 27/05/2026 — Bug Davi Calçados (cancelar venda no PDV)
--
-- # Bug
--
-- Cancelar qualquer venda no PDV resultava em:
--   ERROR 42702: column reference "stock_qty" is ambiguous
-- Railway log apontava o trigger trg_studio_restore_inputs_sale_cancel
-- (em sales AFTER UPDATE OF status). Como TODO cancelamento dispara
-- esse trigger (não só vendas com produto Studio), todo CNPJ do
-- Aura ficou impedido de cancelar venda — não só Davi.
--
-- # Causa raiz
--
-- A função fn_studio_restore_inputs_sale_cancel fazia:
--
--   UPDATE studio_inputs i
--      SET stock_qty = stock_qty + (...)   ← LHS implícito ok, RHS ambíguo
--     FROM sale_items si
--     JOIN products p ON p.id = si.product_id
--     JOIN studio_compositions c ...
--
-- O RHS "stock_qty" é resolvido contra TODAS as relações do statement
-- (target + FROM). studio_inputs tem stock_qty (target), products
-- também tem stock_qty (joined). Postgres recusa no plan, antes de
-- avaliar WHERE (mesmo quando is_personalizable=false elimina tudo).
--
-- Coluna stock_qty existe em 3 tabelas:
--   products, product_variants, studio_inputs.
--
-- # Fix
--
-- Qualificar o RHS com o alias da target: `i.stock_qty`.
-- Mesma higienização aplicada defensivamente em
-- fn_studio_consume_inputs_sale e fn_studio_consume_inputs_digital
-- (hoje sem JOIN com products mas o padrão é o mesmo — qualquer JOIN
-- futuro com products/product_variants reintroduz o bug).
--
-- # Reprodução (SQL)
--
--   BEGIN;
--   UPDATE sales SET status='cancelled' WHERE id='<id-davi>';
--   -- antes do fix: ERROR 42702
--   -- depois:       UPDATE 1
--   ROLLBACK;
--
-- # Aplicação
--
-- Aplicada em produção via Supabase MCP em 2026-05-27 antes do PR
-- (mesmo padrão da memory procedimento_padrao_food_phases). Migration
-- abaixo é a versão versionada da função pra futura referência e
-- novos ambientes (staging etc).
-- ============================================================

-- ── 1. Função que dispara o bug (UPDATE OF status em sales) ───
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

-- ── 2. Defensivo: mesma higienização em fn_studio_consume_inputs_sale
-- Hoje o FROM não tem products/product_variants, então não há
-- ambiguidade. Mas o padrão `SET stock_qty = stock_qty - ...` é uma
-- bomba relógio se alguém adicionar um JOIN com tabela que também
-- tenha stock_qty. Qualificar agora previne re-incidência.
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

-- ── 3. Defensivo: mesma higienização em fn_studio_consume_inputs_digital
-- Análogo à #2: hoje seguro mas o padrão é frágil. Alias `si` da
-- target studio_inputs preservado igual ao original; agora o RHS
-- também é qualificado.
CREATE OR REPLACE FUNCTION fn_studio_consume_inputs_digital()
RETURNS TRIGGER AS $$
BEGIN
  -- Curto-circuito: se a linha não tem product_id ou quantity, ignora.
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
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION fn_studio_restore_inputs_sale_cancel() IS
  'Studio: estorna stock_qty dos studio_inputs quando uma sale eh cancelada. RHS qualificado (i.stock_qty) pra evitar ambiguidade com products.stock_qty no FROM (fix 27/05/2026).';

COMMENT ON FUNCTION fn_studio_consume_inputs_sale() IS
  'Studio: desconta stock_qty dos studio_inputs ao criar sale_items personalizaveis. RHS qualificado defensivamente.';

COMMENT ON FUNCTION fn_studio_consume_inputs_digital() IS
  'Studio: desconta stock_qty dos studio_inputs ao inserir digital_order_items, aplicando qty_multiplier_by_option quando a customization do item bate com algum fieldId configurado. RHS qualificado defensivamente.';
