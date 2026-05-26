-- ============================================================
-- AURA Studio — Multiplier de insumo por variante de personalização
-- 26/05/2026
--
-- Issue 2 backend: até agora studio_composition_items.qty_per_unit
-- era fixa por produto. Não cabe quando uma variante (tamanho P/M/G,
-- cor, etc) consome quantidade diferente do mesmo insumo.
--
-- Schema novo: qty_multiplier_by_option JSONB com shape
--   { "fieldId": { "valueA": 1, "valueB": 2.5, "valueC": 5 } }
-- Lookup: pra cada chave do customization que casa com um fieldId,
-- multiplicar qty_per_unit pelo valor. NULL = qty fixa (default,
-- 90% dos casos).
--
-- Trigger fn_studio_consume_inputs_digital: dispara em
-- digital_order_items AFTER INSERT, desconta stock_qty considerando
-- multiplier por linha. Idempotente: criada via CREATE OR REPLACE.
-- ============================================================

-- ── 1. Coluna multiplier no item de composição ─────────────────
ALTER TABLE studio_composition_items
  ADD COLUMN IF NOT EXISTS qty_multiplier_by_option JSONB DEFAULT NULL;

COMMENT ON COLUMN studio_composition_items.qty_multiplier_by_option IS
  'Multiplier de qty_per_unit por option/color value do customization_config. Ex: {"tamanho":{"p":1,"m":2.5,"g":5}}. NULL = qty fixa.';

-- ── 2. Function que desconta insumos com multiplier ────────────
-- NEW.customization é JSONB tipo { "fieldId": "value", ... } (vem de
-- digital_order_items.customization, populado pelo storefront Studio).
-- Pra cada item de composição, achar o primeiro fieldId que tem
-- multiplier configurado E está presente na customization. Aplicar
-- o multiplier (numérico). Senão, usar 1 (qty fixa, comportamento atual).
CREATE OR REPLACE FUNCTION fn_studio_consume_inputs_digital()
RETURNS TRIGGER AS $$
BEGIN
  -- Curto-circuito: se a linha não tem product_id ou quantity, ignora.
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
$$ LANGUAGE plpgsql;

-- ── 3. Trigger AFTER INSERT em digital_order_items ─────────────
-- Idempotente: drop + create. Só dispara quando a tabela existe
-- (proteção pra ambientes em que migration 070 ainda não rodou).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'digital_order_items'
  ) THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_studio_consume_inputs_digital ON digital_order_items';
    EXECUTE 'CREATE TRIGGER trg_studio_consume_inputs_digital
             AFTER INSERT ON digital_order_items
             FOR EACH ROW
             EXECUTE FUNCTION fn_studio_consume_inputs_digital()';
  END IF;
END $$;

COMMENT ON FUNCTION fn_studio_consume_inputs_digital() IS
  'Studio: desconta stock_qty dos studio_inputs ao inserir digital_order_items, aplicando qty_multiplier_by_option quando a customization do item bate com algum fieldId configurado.';
