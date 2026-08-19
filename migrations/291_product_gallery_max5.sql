-- ============================================================
-- 291 — Galeria do produto: limite passa de 6 para 5 fotos
--
-- A migration 290 criou a galeria com teto de 6, mas o app nunca teve
-- tela pra cadastrar mais de uma foto: em producao, o maximo observado
-- e 1 foto por produto (8.906 produtos, nenhum com galeria > 1). O teto
-- nunca foi exercido.
--
-- Agora que a tela de galeria entra no catalogo do Studio, o numero
-- passa a ser visivel pro lojista — e o combinado e 5. Este arquivo
-- alinha a constraint do banco com src/services/productGallery.js, que
-- e a unica fonte da regra.
--
-- Sem risco de dados: nenhuma linha existente viola o novo teto (o
-- proprio ALTER falharia se violasse, e a verificacao foi feita antes).
-- ============================================================

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_gallery_urls_max6_chk;

DO $$
BEGIN
  ALTER TABLE products
    ADD CONSTRAINT products_gallery_urls_max5_chk
    CHECK (jsonb_typeof(gallery_urls) = 'array' AND jsonb_array_length(gallery_urls) <= 5);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN products.gallery_urls IS
  'Fotos do produto, ate 5, na ordem de exibicao. O indice 0 e a capa e espelha products.image_url (migrations 290, 291).';
