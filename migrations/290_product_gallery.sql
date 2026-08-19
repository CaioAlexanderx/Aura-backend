-- ============================================================
-- 290 — Galeria de fotos do produto, ate 6 (S9)
--
-- `products.image_url` guarda UMA foto. A pagina de produto da F1 pede um
-- carrossel — e uma caneca precisa de mais de um angulo: a estampa, a
-- alca, o interior colorido, a foto de uso. Com uma foto so, a vitrine
-- fica pobre por limitacao de cadastro, nao por falta de material.
--
-- FORMA: array jsonb na propria linha do produto, nao tabela separada.
-- O conjunto e pequeno e limitado (6), sempre lido junto do produto e
-- sempre na mesma ordem. Uma tabela custaria um JOIN em todo payload de
-- vitrine para ganhar flexibilidade que o limite de 6 nega.
--
-- CAPA: gallery_urls[0] E a capa, e `image_url` continua espelhando ela.
-- Isso preserva TODOS os consumidores atuais de image_url — listagem,
-- carrinho, marketplace, notificacao, PDV — sem tocar em nenhum. E o
-- mesmo padrao de dual-write que a F0 usa em products.category, e pela
-- mesma razao: a coluna antiga tem leitor demais para ser trocada de uma
-- vez.
--
-- O backfill deixa a base consistente desde o primeiro dia: quem ja tem
-- foto passa a ter galeria de um item.
-- ============================================================

-- DERIVA DE SCHEMA, corrigida aqui: `products.image_url` existe em
-- producao mas NUNCA entrou como migration — foi criada direto na base. O
-- CI monta o schema so a partir desta pasta, entao a coluna nao existia
-- la, e o backfill abaixo quebrou o build. `IF NOT EXISTS` torna a linha
-- inofensiva em producao e conserta o schema de teste de uma vez.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS gallery_urls JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN products.gallery_urls IS
  'Fotos do produto, ate 6, na ordem de exibicao. O indice 0 e a capa e espelha products.image_url (migration 290).';

-- Backfill: produto com foto vira galeria de um item. Idempotente — so
-- toca quem ainda esta com a galeria vazia.
UPDATE products
   SET gallery_urls = jsonb_build_array(image_url)
 WHERE image_url IS NOT NULL
   AND btrim(image_url) <> ''
   AND gallery_urls = '[]'::jsonb;

DO $$
BEGIN
  ALTER TABLE products
    ADD CONSTRAINT products_gallery_urls_max6_chk
    CHECK (jsonb_typeof(gallery_urls) = 'array' AND jsonb_array_length(gallery_urls) <= 6);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
