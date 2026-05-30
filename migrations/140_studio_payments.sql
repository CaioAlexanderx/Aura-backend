-- 140_studio_payments.sql
-- Studio Camada 1: Marcos de pagamento por pedido — sinal/saldo (Fase C, 30/05/2026)
-- DA-D: cobrança via Pix manual (mark-paid) + modalidade existente da loja virtual.
-- FK order_id → digital_orders (pedidos Studio ficam em digital_orders WHERE vertical='studio').

CREATE TABLE IF NOT EXISTS studio_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL REFERENCES digital_orders(id) ON DELETE CASCADE,
  -- kind: deposit = sinal, balance = saldo restante, full = pagamento único
  kind            text NOT NULL CHECK (kind IN ('deposit','balance','full')),
  amount          numeric(12,2) NOT NULL,
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paid','cancelled')),
  -- method: método registrado (principalmente pix no MVP — DA-D)
  method          text CHECK (method IN ('pix','card','cash','other')),
  asaas_charge_id text,    -- futuro: ID da cobrança Asaas (DA-D v2)
  due_at          timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS studio_payments_company_id_idx ON studio_payments(company_id);
CREATE INDEX IF NOT EXISTS studio_payments_order_id_idx   ON studio_payments(order_id);
