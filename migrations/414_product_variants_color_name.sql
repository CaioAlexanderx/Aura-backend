-- ============================================================
-- 414 — Nome da cor por variante (tq-55b, 26/10/2026)
--
-- O nome que a lojista dá à cor ("Off", "Militar", "Azul petróleo") só
-- ficava em product_variants.sku_suffix, em maiúsculas e cortado em 10
-- letras (productsVariations.skuSuffixFromAttrs). O Caixa (app#1141, tq-55)
-- lê o sufixo e cai na paleta quando o nome tem 10 letras ou mais.
--
-- Coluna nova, nullable, sem default: o PUT /variations passa a gravar o
-- nome como veio; o GET /variations e o GET /products/:pid/variants devolvem.
-- NÃO preenche linha nenhuma: variantes antigas ficam com NULL e o app segue
-- lendo o sufixo, como hoje. sku_suffix não muda.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
-- Caminho de volta: ALTER TABLE product_variants DROP COLUMN IF EXISTS color_name;
-- (e reverter o PR: o código lê e grava a coluna).
-- ============================================================

ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS color_name TEXT;

COMMENT ON COLUMN product_variants.color_name IS
  'Nome da cor como a lojista digitou (tq-55b, 26/10/2026). NULL = variante sem cor ou gravada antes da 414; o app cai no sku_suffix e depois na paleta.';
