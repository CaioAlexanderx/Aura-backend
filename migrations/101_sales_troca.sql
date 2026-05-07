-- ============================================================
-- 101_sales_troca.sql
-- Suporte a troca de produtos no PDV (POST /pdv/troca).
--
-- Problema reportado: "Erro ao registrar troca" — o endpoint
-- POST /pdv/troca faz INSERT em sales com colunas type e
-- exchange_of_sale_id que não existiam no banco, causando
-- falha silenciosa (500) no catch do Node.
--
-- Alterações:
--   1. sales.type           — 'sale' (padrão) ou 'troca'
--   2. sales.exchange_of_sale_id — FK para a venda original
--   3. troca_returned_items — itens devolvidos na troca
-- ============================================================

-- 1. Coluna type em sales (DEFAULT 'sale' pra não quebrar registros existentes)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'sale';

-- 2. FK para a venda original (NULL para vendas normais)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS exchange_of_sale_id UUID NULL
    REFERENCES sales(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_exchange_of
  ON sales (exchange_of_sale_id)
  WHERE exchange_of_sale_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_type
  ON sales (company_id, type)
  WHERE type != 'sale';

-- 3. Tabela de itens devolvidos em uma troca
CREATE TABLE IF NOT EXISTS troca_returned_items (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  troca_sale_id        UUID         NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  original_sale_id     UUID         NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  product_id           UUID         NULL REFERENCES products(id) ON DELETE SET NULL,
  variant_id           UUID         NULL REFERENCES product_variants(id) ON DELETE SET NULL,
  quantity             NUMERIC(12,4) NOT NULL CHECK (quantity > 0),
  unit_price           NUMERIC(12,2) NOT NULL,
  product_name_snapshot TEXT         NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_troca_ret_troca_sale
  ON troca_returned_items (troca_sale_id);

CREATE INDEX IF NOT EXISTS idx_troca_ret_original_sale
  ON troca_returned_items (original_sale_id);

COMMENT ON TABLE troca_returned_items IS
  'Itens devolvidos pelo cliente em uma troca (type=troca em sales). '
  'troca_sale_id aponta para o registro da troca; original_sale_id para a venda original.';

COMMENT ON COLUMN sales.type IS
  '''sale'' = venda normal, ''troca'' = troca de produto. '
  'Vendas do tipo troca têm exchange_of_sale_id preenchido.';

COMMENT ON COLUMN sales.exchange_of_sale_id IS
  'UUID da venda original que gerou esta troca. NULL para vendas normais.';
