-- ============================================================
-- AURA. — Migration 018: PDV-01 complementos
-- Tabela de pagamentos múltiplos por venda
-- Colunas adicionais em sales
-- Aplicar manualmente no Supabase SQL Editor
-- ============================================================

-- Múltiplos pagamentos por venda (ex: 50% dinheiro + 50% Pix)
CREATE TABLE IF NOT EXISTS sale_payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id     UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  method      TEXT NOT NULL,   -- pix | dinheiro | cartao | debito | credito | fiado
  amount      NUMERIC(12,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sale_id, method)
);

CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);
ALTER TABLE sale_payments ENABLE ROW LEVEL SECURITY;

-- Colunas adicionais em sales
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS cash_tendered    NUMERIC(12,2),  -- valor entregue em dinheiro
  ADD COLUMN IF NOT EXISTS pix_payload      TEXT,           -- payload Pix para QR
  ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS product_name_snapshot TEXT;     -- snapshot nome se produto deletado

-- Coluna snapshot em sale_items (já pode existir, é idempotente)
ALTER TABLE sale_items
  ADD COLUMN IF NOT EXISTS product_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS item_discount          NUMERIC(10,2) NOT NULL DEFAULT 0;

-- Tabela de movimentações de estoque (usada pela baixa automática do PDV e Food)
CREATE TABLE IF NOT EXISTS stock_movements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('in','out','adjustment')),
  quantity        NUMERIC(10,3) NOT NULL,
  reference_id    UUID,        -- sale_id, food_order_id, etc.
  reference_type  TEXT,        -- 'sale' | 'food_order' | 'manual'
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_mov_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_mov_company ON stock_movements(company_id, created_at DESC);
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
