-- 257_categories_tree_structure
-- F0 Loja Digital v2 - Bloco A
-- Transforma product_categories (flat, migration 044/045) em arvore de 3 niveis,
-- respeitando o discriminador type ('product' | 'service') da migration 045.

-- 1. Funcao canonica de slug. STABLE porque unaccent() e STABLE.
--    Usada no backfill E no trigger (259) para nao haver duas regras divergentes.
CREATE OR REPLACE FUNCTION category_slugify(p_name text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT btrim(
           regexp_replace(lower(unaccent(btrim(coalesce(p_name, '')))), '[^a-z0-9]+', '-', 'g'),
           '-'
         );
$$;

-- 2. Colunas de arvore
ALTER TABLE product_categories
  ADD COLUMN IF NOT EXISTS parent_id  uuid REFERENCES product_categories(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS slug       text,
  ADD COLUMN IF NOT EXISTS path       text,
  ADD COLUMN IF NOT EXISTS depth      smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS image_url  text,
  ADD COLUMN IF NOT EXISTS banner_url text,
  ADD COLUMN IF NOT EXISTS is_visible_storefront boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS seo_title  text,
  ADD COLUMN IF NOT EXISTS seo_description text,
  ADD COLUMN IF NOT EXISTS product_count integer NOT NULL DEFAULT 0;

-- 3. Trava de profundidade: 3 niveis (0, 1, 2). Idempotente.
DO $$
BEGIN
  ALTER TABLE product_categories
    ADD CONSTRAINT product_categories_depth_max CHECK (depth BETWEEN 0 AND 2);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 4. Coluna normalizada para deduplicacao.
--    unaccent() e STABLE: proibido em coluna gerada. Tratamos so caixa e espaco.
--    Acento e tratado na UI, no aviso de duplicata provavel, nunca em constraint.
ALTER TABLE product_categories
  ADD COLUMN IF NOT EXISTS name_norm text
  GENERATED ALWAYS AS (lower(btrim(name))) STORED;

-- 5. Unicidade sob o mesmo pai, DENTRO DO MESMO type.
--    COALESCE no parent_id: o Postgres trata NULLs como distintos em indice unico.
CREATE UNIQUE INDEX IF NOT EXISTS product_categories_unique_sibling
  ON product_categories (
    company_id,
    type,
    COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    name_norm
  );

CREATE INDEX IF NOT EXISTS product_categories_parent_idx
  ON product_categories (company_id, type, parent_id, sort_order);

-- 6. Backfill das linhas existentes (55 em 3 empresas, todas type='product').
--    Sem isto elas nascem com slug/path NULL e somem da query de arvore.
--    Colisao verificada em 28/07: 0 em name_norm e 0 em slug.
UPDATE product_categories
   SET slug = category_slugify(name),
       depth = 0,
       parent_id = NULL
 WHERE slug IS NULL;

UPDATE product_categories
   SET path = '/' || slug
 WHERE path IS NULL AND slug IS NOT NULL;

-- 7. Path unico por empresa e type (rota da loja). Criado DEPOIS do backfill.
CREATE UNIQUE INDEX IF NOT EXISTS product_categories_unique_path
  ON product_categories (company_id, type, path) WHERE path IS NOT NULL;

-- NOTA: o unique legado product_categories_company_type_name_key (company_id, type, name)
-- e mantido de proposito. E um subconjunto mais fraco do indice de irmaos e protege
-- contra regressao se alguem escrever direto na tabela. Nao dropar nesta fase.
