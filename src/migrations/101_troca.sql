-- ============================================================
-- Migration 101 · Troca (exchange) no PDV
-- Adiciona type e exchange_of_sale_id em sales.
-- Cria troca_returned_items para registrar os itens devolvidos.
-- ============================================================

-- 1. Coluna type: 'sale' (default) ou 'troca'
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'sale';

ALTER TABLE sales
  DROP CONSTRAINT IF EXISTS sales_type_check;

ALTER TABLE sales
  ADD CONSTRAINT sales_type_check
  CHECK (type IN ('sale', 'troca'));

-- 2. FK para a venda original trocada (nullable)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS exchange_of_sale_id UUID REFERENCES sales(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_exchange_of ON sales(exchange_of_sale_id)
  WHERE exchange_of_sale_id IS NOT NULL;

-- 3. Tabela de itens devolvidos na troca
CREATE TABLE IF NOT EXISTS troca_returned_items (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  troca_sale_id        UUID        NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  original_sale_id     UUID        NOT NULL REFERENCES sales(id),
  product_id           UUID        REFERENCES products(id) ON DELETE SET NULL,
  variant_id           UUID        REFERENCES product_variants(id) ON DELETE SET NULL,
  quantity             NUMERIC(10,3) NOT NULL,
  unit_price           NUMERIC(14,2) NOT NULL,
  product_name_snapshot TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_troca_returned_troca_sale
  ON troca_returned_items(troca_sale_id);

CREATE INDEX IF NOT EXISTS idx_troca_returned_original_sale
  ON troca_returned_items(original_sale_id);
