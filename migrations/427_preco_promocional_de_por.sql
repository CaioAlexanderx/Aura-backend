-- ============================================================
-- 427 — Preco promocional com data (De/Por, p-84, 08/11/2026)
--
-- Promocao por item, escolhida pela DATA na leitura (opcao A aprovada):
--   products.promo_price / promo_starts_at / promo_ends_at
--   product_variants.promo_price / promo_starts_at / promo_ends_at
--
-- `price` (e `price_override` na variante) continua sendo o preco normal,
-- o "De". Nenhum job devolve nada: vencida a data, a leitura volta ao
-- preco normal sozinha. Uma promocao por item: a nova substitui a anterior.
-- Variante com price_override e item proprio; variante sem price_override
-- segue a promocao do produto (ou tem a sua, com base no preco do produto).
-- Produto de grupo (is_group_shared) e uma linha so: vale para o grupo.
--
-- Regra unica (a mesma de src/services/precoEfetivo.js):
--   em_promocao   = promo_price IS NOT NULL AND promo_price > 0
--                   AND promo_price < preco base
--                   AND promo_starts_at <= agora AND promo_ends_at > agora
--   preco_efetivo = em_promocao ? promo_price : preco base
-- As funcoes aura_em_promocao / aura_preco_efetivo abaixo servem para
-- consulta e relatorio no banco; o codigo usa o modulo JS (que nao depende
-- da funcao existir) e um teste .banco confere que os dois concordam.
--
-- Nenhuma linha existente muda (colunas novas nascem nulas). Idempotente.
-- Caminho de volta (depois de reverter os PRs p-84/p-85):
--   DROP FUNCTION IF EXISTS aura_preco_efetivo(numeric, numeric, timestamptz, timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS aura_em_promocao(numeric, numeric, timestamptz, timestamptz, timestamptz);
--   ALTER TABLE product_variants DROP COLUMN IF EXISTS promo_price,
--     DROP COLUMN IF EXISTS promo_starts_at, DROP COLUMN IF EXISTS promo_ends_at;
--   ALTER TABLE products DROP COLUMN IF EXISTS promo_price,
--     DROP COLUMN IF EXISTS promo_starts_at, DROP COLUMN IF EXISTS promo_ends_at;
-- ============================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_price NUMERIC(12,2) NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_starts_at TIMESTAMPTZ NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS promo_ends_at TIMESTAMPTZ NULL;

ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS promo_price NUMERIC(12,2) NULL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS promo_starts_at TIMESTAMPTZ NULL;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS promo_ends_at TIMESTAMPTZ NULL;

-- Os tres campos andam juntos (todos nulos ou todos preenchidos), preco
-- positivo e fim depois do comeco. A rota ja valida; a trava e a garantia.
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_promo_coerente CHECK (
    (promo_price IS NULL AND promo_starts_at IS NULL AND promo_ends_at IS NULL)
    OR (promo_price > 0 AND promo_starts_at IS NOT NULL AND promo_ends_at IS NOT NULL
        AND promo_ends_at > promo_starts_at)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE product_variants ADD CONSTRAINT product_variants_promo_coerente CHECK (
    (promo_price IS NULL AND promo_starts_at IS NULL AND promo_ends_at IS NULL)
    OR (promo_price > 0 AND promo_starts_at IS NOT NULL AND promo_ends_at IS NOT NULL
        AND promo_ends_at > promo_starts_at)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Lista da pagina Black Friday (GET /products/promotions): so as linhas com
-- promocao gravada, que sao poucas.
CREATE INDEX IF NOT EXISTS idx_products_promo
  ON products (company_id, promo_ends_at) WHERE promo_price IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_product_variants_promo
  ON product_variants (product_id, promo_ends_at) WHERE promo_price IS NOT NULL;

CREATE OR REPLACE FUNCTION aura_em_promocao(
  base NUMERIC, promo NUMERIC, inicio TIMESTAMPTZ, fim TIMESTAMPTZ, agora TIMESTAMPTZ DEFAULT now()
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    promo IS NOT NULL AND promo > 0 AND base IS NOT NULL AND promo < base
    AND inicio IS NOT NULL AND fim IS NOT NULL AND inicio <= agora AND fim > agora,
    false)
$$;

CREATE OR REPLACE FUNCTION aura_preco_efetivo(
  base NUMERIC, promo NUMERIC, inicio TIMESTAMPTZ, fim TIMESTAMPTZ, agora TIMESTAMPTZ DEFAULT now()
) RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN aura_em_promocao(base, promo, inicio, fim, agora) THEN promo ELSE base END
$$;
