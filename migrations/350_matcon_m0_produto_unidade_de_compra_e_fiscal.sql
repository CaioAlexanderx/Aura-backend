-- ============================================================
-- 350 — Matcon (materiais de construcao): unidade de compra e fiscal do
--       Simples no produto
--
-- Contexto (22/09/2026): semi-vertical Matcon sobre o shell de varejo
-- (aura-app PRs #927/#929/#930/#931/#932). Contrato completo em
-- aura-app/docs/CONTRACT_MATCON.md. Esta migration cobre so as colunas de
-- PRODUTO (secoes M0 e M2). O opt-in (pdv_settings.matcon_*) nao precisa
-- de migration: pdv_settings e jsonb, a whitelist esta em
-- src/routes/pdvSettings.js. stock_qty / sale_items.quantity ja sao
-- NUMERIC(10,3) desde a 001 — o estoque fracionado (12,5 m²) so estava
-- sendo truncado por parseInt na rota, corrigido junto.
--
-- DECISOES:
-- - purchase_unit/purchase_factor: "compro por caixa de 2,32 m²". NULL =
--   compra na mesma unidade que vende. factor > 0 validado na rota.
-- - weight_kg: peso por unidade de venda, para o bloco <transp> da NF-e
--   emitida a partir de uma entrega (M2).
-- - cest (7 digitos), origem (0-8), icms_st_paid: o varejista do Simples
--   nao calcula ST — marca "o imposto ja veio recolhido" e a emissao usa
--   CSOSN 500 (true) ou 102 (false/NULL). Motor de ST fica fora.
-- - Tudo nullable, sem default: loja sem Matcon nunca escreve aqui e nada
--   muda para ela (contrato de zero impacto).
--
-- Quotes/deliveries (M1), professionals (M3), product_lots e
-- purchase_orders (M4) vem em migrations proprias.
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS purchase_unit   VARCHAR(10),
  ADD COLUMN IF NOT EXISTS purchase_factor NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS weight_kg       NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS cest            VARCHAR(7),
  ADD COLUMN IF NOT EXISTS origem          SMALLINT,
  ADD COLUMN IF NOT EXISTS icms_st_paid    BOOLEAN;

COMMENT ON COLUMN products.purchase_unit   IS 'Matcon: unidade em que a loja compra (cx, sc, pct...). NULL = mesma da venda.';
COMMENT ON COLUMN products.purchase_factor IS 'Matcon: quantas unidades de venda cabem em 1 unidade de compra (caixa de 2,32 m²).';
COMMENT ON COLUMN products.weight_kg       IS 'Matcon: peso por unidade de venda, para o transporte da NF-e.';
COMMENT ON COLUMN products.cest            IS 'Matcon M2: CEST (7 digitos), obrigatorio na nota de item com ST.';
COMMENT ON COLUMN products.origem          IS 'Matcon M2: origem da mercadoria (0-8, tabela SEFAZ).';
COMMENT ON COLUMN products.icms_st_paid    IS 'Matcon M2: imposto ja recolhido na compra -> CSOSN 500; senao 102.';
