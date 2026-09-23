-- ============================================================
-- 351 — Preco no cartao: preco proprio do produto para debito/credito
--
-- Contexto (22/09/2026): a loja pode cobrar mais no cartao. Opcao da loja
-- (todos os planos), desligada por padrao. Ligada, vale um acrescimo
-- padrao em % (pdv_settings.card_price_pct) e, por produto, este preco
-- opcional que substitui o %. O opt-in (pdv_settings.card_price_enabled /
-- card_price_pct) nao precisa de migration: pdv_settings e jsonb, a
-- whitelist esta em src/routes/pdvSettings.js.
--
-- DECISOES:
-- - Mesmo preco para debito e credito; dinheiro, PIX e crediario usam o
--   preco normal (products.price).
-- - NULL = segue o acrescimo padrao da loja. Sem default e sem backfill:
--   loja que nunca ligou a opcao nunca escreve aqui e nada muda para ela
--   (contrato de zero impacto).
-- - Quem decide o preco da venda e o Caixa (front), que manda unit_price
--   no POST /pdv/sale. A venda e a NFC-e NAO mudam: continuam usando o
--   unit_price enviado.
-- - Validacao (> 0, 2 casas) fica na rota (products.js / importData.js).
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS card_price NUMERIC(10,2) NULL;

COMMENT ON COLUMN products.card_price IS 'Preco no cartao (debito/credito). NULL = segue pdv_settings.card_price_pct.';
