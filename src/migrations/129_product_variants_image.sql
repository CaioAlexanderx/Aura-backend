-- ============================================================
-- Migration 129 (23/05/2026) — foto por variante de produto
--
-- Adiciona image_url em product_variants para suportar:
--   • Upload de foto especifica por combinacao (cor/tamanho)
--   • Storefront publico: foto da variante substitui a do pai
--     ao selecionar uma cor no detalhe do produto
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
-- Sem default — variantes existentes ficam com image_url NULL e
-- caem no fallback (foto do produto pai).
-- ============================================================

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN product_variants.image_url IS
  'URL R2 da foto especifica desta variante (substitui foto do pai quando setada).';
