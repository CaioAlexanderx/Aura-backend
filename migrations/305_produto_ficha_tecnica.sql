-- 305 — ficha tecnica do produto na pagina publica.
--
-- A pagina de produto mostra foto, cor, tamanho, preco e descricao. O que
-- o cliente ainda pergunta antes de comprar roupa e "de que e feito?" e
-- "quanto mede?" — e nao havia onde a lojista responder: products tem
-- brand, description, sku e ncm, e mais nada de ficha.
--
-- TEXTO LIVRE de proposito. Campo estruturado (percentual de composicao,
-- tabela de medidas por tamanho) e outro projeto; aqui o objetivo e a
-- lojista conseguir escrever "Viscose com elastano" e "Busto 92cm,
-- comprimento 105cm" sem esperar uma modelagem.
--
-- Idempotente. NULL = a secao nao aparece na loja.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS material TEXT,
  ADD COLUMN IF NOT EXISTS medidas TEXT,
  ADD COLUMN IF NOT EXISTS cuidados TEXT;

COMMENT ON COLUMN products.material IS
  'Do que a peca e feita, texto livre. Ex.: "Viscose com elastano".';
COMMENT ON COLUMN products.medidas IS
  'Medidas da peca, texto livre. Ex.: "Busto 92cm, comprimento 105cm".';
COMMENT ON COLUMN products.cuidados IS
  'Como cuidar, texto livre. Ex.: "Lavar a mao, nao usar secadora".';
