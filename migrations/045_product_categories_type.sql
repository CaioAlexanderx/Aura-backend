-- ============================================================
-- 045_product_categories_type.sql
-- Adiciona coluna `type` em product_categories para permitir
-- categorias distintas para produtos e servicos. A UNIQUE passa
-- a considerar (company_id, type, name), para que "Coloracao"
-- possa existir simultaneamente em produto e servico.
-- ============================================================

-- 1. Adiciona coluna type com default 'product' (nao quebra o que ja existe)
ALTER TABLE product_categories
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'product';

-- 2. Reclassifica a categoria "Servicos" (genérica, criada no seed anterior)
-- como tipo 'service' para cada empresa
UPDATE product_categories
   SET type = 'service'
 WHERE LOWER(TRIM(name)) IN ('servicos', 'serviços', 'serviço', 'servico');

-- 3. Troca a UNIQUE constraint para incluir type
ALTER TABLE product_categories
  DROP CONSTRAINT IF EXISTS product_categories_company_id_name_key;

ALTER TABLE product_categories
  ADD CONSTRAINT product_categories_company_type_name_key
    UNIQUE (company_id, type, name);

-- 4. Seed: para cada empresa, cria categorias do tipo 'service'
-- a partir dos servicos existentes (products com unit='srv' ou categoria
-- normalizada para 'servicos')
INSERT INTO product_categories (company_id, name, type, sort_order)
SELECT DISTINCT
       p.company_id,
       COALESCE(NULLIF(TRIM(p.category), ''), 'Servicos') AS name,
       'service' AS type,
       0 AS sort_order
FROM products p
WHERE p.unit = 'srv'
   OR LOWER(TRIM(COALESCE(p.category, ''))) IN ('servicos', 'serviços')
ON CONFLICT (company_id, type, name) DO NOTHING;

-- 5. Index otimizado por type
CREATE INDEX IF NOT EXISTS idx_product_categories_company_type
  ON product_categories(company_id, type, sort_order, name);
