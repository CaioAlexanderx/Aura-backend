-- ============================================================
-- 424 — Fornecedores por produto (custo por fornecedor) e entrada de
--       mercadoria com variante
--
-- Contexto (03/11/2026, pedido do PO): "o mesmo produto pode ter custos
-- diferentes de acordo com o fornecedor". Mockup aprovado:
-- aura-app docs/mockups/estoque-entrada-por-fornecedor.html (telas 1-9).
--
-- DECISÕES:
--
-- (a) NÃO É VARIANTE. Variante abre o seletor no Caixa em toda venda; o
--     cliente final não vê diferença entre fornecedores. O produto continua
--     um só; o fornecedor (e o custo dele) mora numa tabela ao lado.
--
-- (b) product_suppliers: um produto, vários fornecedores, cada um com o
--     SEU custo ("custo de tabela": o que ele cobra hoje), o código do
--     produto no fornecedor e um principal (o de recompra). UNIQUE
--     (product_id, supplier_id) e no máximo um principal por produto
--     (índice parcial). company_id = o dono do PRODUTO (products.company_id),
--     igual às outras tabelas penduradas em produto.
--     products.supplier_id (342) passa a ESPELHAR o principal, para tudo
--     que já lê essa coluna (sugestão de compra, tela Fornecedores, Matcon)
--     seguir funcionando sem mudança.
--
-- (c) stock_movements.variant_id: produto com cor/tamanho guarda o estoque
--     na variante; a entrada precisa dizer em qual. Nullable, sem backfill.
--
-- (d) Custo médio: products.weighted_avg_cost já existe (nunca usado até
--     aqui). A rota de entrada calcula a média ponderada sobre o estoque
--     POSITIVO de antes e, por padrão, copia para cost_price (o custo que a
--     margem e os relatórios usam).
--
-- (e) BACKFILL: quem já tem products.supplier_id vira a linha principal em
--     product_suppliers, com o cost_price do produto como custo daquele
--     fornecedor (0 vira NULL: custo não informado).
--
-- Idempotente (padrão do repo). Aditiva: nada existente muda de forma.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_suppliers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id       UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id      UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  cost             NUMERIC(12,4),
  supplier_code    TEXT,
  is_main          BOOLEAN NOT NULL DEFAULT false,
  last_purchase_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE product_suppliers IS '424 (03/11/2026) -- fornecedores de um produto, cada um com o seu custo. products.supplier_id espelha o principal (is_main).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_suppliers_par
  ON product_suppliers(product_id, supplier_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_suppliers_principal
  ON product_suppliers(product_id) WHERE is_main;
CREATE INDEX IF NOT EXISTS idx_product_suppliers_supplier
  ON product_suppliers(supplier_id);
CREATE INDEX IF NOT EXISTS idx_product_suppliers_company
  ON product_suppliers(company_id);

ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_product_in
  ON stock_movements(product_id, created_at DESC) WHERE type = 'in';

-- Backfill (e): fornecedor já ligado vira o principal.
INSERT INTO product_suppliers (company_id, product_id, supplier_id, cost, is_main)
SELECT p.company_id, p.id, p.supplier_id, NULLIF(p.cost_price, 0), true
  FROM products p
 WHERE p.supplier_id IS NOT NULL
ON CONFLICT DO NOTHING;
