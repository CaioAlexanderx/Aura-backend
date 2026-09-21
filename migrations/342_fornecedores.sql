-- ============================================================
-- 342 — Cadastro de fornecedores (Fase 1)
--
-- Contexto (16/09/2026): um cliente de trial trocou a Aura por um
-- concorrente citando "cadastro de fornecedores" -- e o unico recurso
-- que ele pediu que o varejo da Aura realmente nao tem. Hoje existe so
-- no Studio (studio_inputs.supplier_name/supplier_phone, insumo de
-- producao) e, solto, em products.supplier_name/products.supplier_cnpj
-- (texto livre, sem entidade, sem telefone/e-mail/contato, sem dedupe).
--
-- DECISOES:
--
-- (a) TABELA PROPRIA, NAO REUSA studio_inputs. O Studio guarda
--     fornecedor de INSUMO (materia-prima de producao), dominio e
--     vertical (Negocio+) diferentes do varejo (Essencial). Misturar
--     acoplaria as duas tabelas por acidente de nome de coluna.
--
-- (b) VISIBILIDADE DE GRUPO SEM FLAG POR LINHA. `products` precisa de
--     is_group_shared por produto porque cada produto pode ser privado
--     ou compartilhado dentro do grupo. Fornecedor e dado de
--     retaguarda -- dentro do MESMO grupo economico (billing group) a
--     matriz e as filiais compram do(s) mesmo(s) fornecedor(es); nao
--     ha caso de uso pra fornecedor "privado" de uma filial dentro do
--     grupo. Por isso suppliers NAO tem is_group_shared: a visibilidade
--     de grupo (implementada em src/routes/suppliers.js, mesmo
--     group_root de products.js/visibilityWhere) e incondicional.
--
-- (c) products.supplier_name / products.supplier_cnpj SAO CRIADAS AQUI
--     COM IF NOT EXISTS. Essas duas colunas ja sao escritas hoje por
--     src/routes/importData.js (import de NF-e), mas nenhuma migration
--     commitada neste repo jamais as criou -- sinal do padrao descrito
--     no cabecalho de src/utils/migrationRunner.js (coluna existe em
--     produção via ALTER manual, sem arquivo correspondente). O
--     IF NOT EXISTS cobre os dois mundos: producao (onde ja existem,
--     vira no-op) e o Postgres limpo do CI (onde sao criadas agora,
--     pre-requisito do backfill abaixo, que le as duas).
--
-- (d) BACKFILL dedupe por CNPJ quando houver; senao por
--     lower(trim(name)). Guardado com NOT EXISTS (nao ON CONFLICT) pra
--     ficar idempotente mesmo pra fornecedor sem CNPJ, que nao tem
--     unique index (so o CNPJ tem, por empresa).
--
-- Idempotente (padrao do repo): reaplicar este arquivo nao duplica
-- tabela, coluna, indice nem fornecedor.
-- ============================================================

-- ── (0) Colunas soltas que o import de NF-e ja escreve ───────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_name TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_cnpj TEXT;

-- ── (1) Tabela suppliers ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  cnpj          TEXT,
  contact_name  TEXT,
  phone         TEXT,
  email         TEXT,
  notes         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE suppliers IS 'Fase 1 fornecedores (16/09/2026) -- cadastro de fornecedores do varejo. Nao confundir com studio_inputs (insumos de producao do Studio).';

-- Dedupe por CNPJ dentro da empresa. Parcial: fornecedor sem CNPJ
-- (autonomo/informal) nao entra na unicidade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_suppliers_company_cnpj
  ON suppliers(company_id, cnpj) WHERE cnpj IS NOT NULL;

-- Busca/autocomplete por nome (GET /suppliers?q=).
CREATE INDEX IF NOT EXISTS idx_suppliers_company_name
  ON suppliers(company_id, lower(name));

-- ── (2) products.supplier_id ───────────────────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);

-- ── (3) stock_movements.supplier_id + unit_cost ─────────────────────────
-- stock_movements nasce na migration 018 (sempre antes desta na ordem
-- lexicografica que o CI e o runner aplicam) -- sem necessidade de
-- guarda contra 42P01 aqui.
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,2);

-- ── (4) Backfill: suppliers a partir de products.supplier_name/cnpj ────
WITH fonte AS (
  SELECT
    company_id,
    NULLIF(trim(supplier_name), '') AS supplier_name,
    NULLIF(regexp_replace(COALESCE(supplier_cnpj, ''), '\D', '', 'g'), '') AS cnpj_digits
  FROM products
  WHERE NULLIF(trim(supplier_name), '') IS NOT NULL
     OR NULLIF(regexp_replace(COALESCE(supplier_cnpj, ''), '\D', '', 'g'), '') IS NOT NULL
),
dedup AS (
  SELECT DISTINCT ON (company_id, COALESCE(cnpj_digits, lower(supplier_name)))
    company_id,
    COALESCE(supplier_name, 'Fornecedor sem nome') AS name,
    cnpj_digits AS cnpj
  FROM fonte
  ORDER BY company_id, COALESCE(cnpj_digits, lower(supplier_name)), supplier_name NULLS LAST
)
INSERT INTO suppliers (company_id, name, cnpj)
SELECT d.company_id, d.name, d.cnpj
FROM dedup d
WHERE NOT EXISTS (
  SELECT 1 FROM suppliers s
  WHERE s.company_id = d.company_id
    AND (
      (d.cnpj IS NOT NULL AND s.cnpj = d.cnpj)
      OR (d.cnpj IS NULL AND s.cnpj IS NULL AND lower(trim(s.name)) = lower(trim(d.name)))
    )
);

-- ── (5) Backfill: products.supplier_id ──────────────────────────────────
UPDATE products p
SET supplier_id = s.id
FROM suppliers s
WHERE p.supplier_id IS NULL
  AND s.company_id = p.company_id
  AND (
    (
      NULLIF(regexp_replace(COALESCE(p.supplier_cnpj, ''), '\D', '', 'g'), '') IS NOT NULL
      AND s.cnpj = NULLIF(regexp_replace(COALESCE(p.supplier_cnpj, ''), '\D', '', 'g'), '')
    )
    OR (
      NULLIF(regexp_replace(COALESCE(p.supplier_cnpj, ''), '\D', '', 'g'), '') IS NULL
      AND s.cnpj IS NULL
      AND NULLIF(trim(p.supplier_name), '') IS NOT NULL
      AND lower(trim(s.name)) = lower(trim(p.supplier_name))
    )
  );
