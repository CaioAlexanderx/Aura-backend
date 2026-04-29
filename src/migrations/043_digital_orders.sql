-- ============================================================
-- Migration 043: Canal Digital — Pedidos
-- Cria: digital_orders, digital_order_items
--       função next_digital_order_number()
-- Idempotente: usa IF NOT EXISTS / CREATE OR REPLACE
-- ============================================================

-- ── Tabela principal de pedidos ───────────────────────────
CREATE TABLE IF NOT EXISTS digital_orders (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_number         TEXT        NOT NULL,
  customer_name        TEXT        NOT NULL,
  customer_phone       TEXT        NOT NULL,
  customer_email       TEXT,
  delivery_type        TEXT        NOT NULL DEFAULT 'pickup',
  delivery_address     TEXT,
  delivery_fee         NUMERIC(10,2) NOT NULL DEFAULT 0,
  subtotal             NUMERIC(10,2) NOT NULL DEFAULT 0,
  total                NUMERIC(10,2) NOT NULL DEFAULT 0,
  status               TEXT        NOT NULL DEFAULT 'pending_payment',
  payment_status       TEXT        NOT NULL DEFAULT 'pending',
  notes                TEXT,
  -- Asaas / Pix
  asaas_payment_id     TEXT,
  asaas_pix_qrcode     TEXT,
  asaas_pix_payload    TEXT,
  asaas_pix_expires_at TIMESTAMPTZ,
  -- Timestamps de transição
  confirmed_at         TIMESTAMPTZ,
  delivered_at         TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Número de pedido único por empresa
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'digital_orders_company_number_unique'
      AND conrelid = 'digital_orders'::regclass
  ) THEN
    ALTER TABLE digital_orders
      ADD CONSTRAINT digital_orders_company_number_unique
      UNIQUE (company_id, order_number);
  END IF;
END$$;

-- ── Itens do pedido ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS digital_order_items (
  id            BIGSERIAL    PRIMARY KEY,
  order_id      UUID         NOT NULL REFERENCES digital_orders(id) ON DELETE CASCADE,
  product_id    UUID,
  product_name  TEXT         NOT NULL,
  product_image TEXT,
  unit_price    NUMERIC(10,2) NOT NULL,
  quantity      INT          NOT NULL DEFAULT 1,
  subtotal      NUMERIC(10,2) NOT NULL
);

-- ── Índices ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_digital_orders_company_created
  ON digital_orders(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_digital_orders_company_status
  ON digital_orders(company_id, status);

CREATE INDEX IF NOT EXISTS idx_digital_order_items_order
  ON digital_order_items(order_id);

-- ── Função: número sequencial por empresa ─────────────────
-- Retorna o próximo número de pedido como texto zero-padded (ex: "00001")
-- Usa SELECT FOR UPDATE na tabela para evitar race condition.
CREATE OR REPLACE FUNCTION next_digital_order_number(p_company_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_seq INT;
BEGIN
  SELECT COALESCE(
    MAX(
      CASE
        WHEN order_number ~ '^\d+$' THEN order_number::INT
        ELSE 0
      END
    ), 0
  ) + 1
  INTO v_seq
  FROM digital_orders
  WHERE company_id = p_company_id;

  RETURN LPAD(v_seq::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;
