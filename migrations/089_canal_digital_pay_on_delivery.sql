-- ============================================================
-- 089_canal_digital_pay_on_delivery.sql
-- AURA. — Canal Digital: pagamento na entrega + payment_method
--
-- Permite ao lojista oferecer "pagar na entrega" como alternativa ao Pix.
-- Cliente escolhe no checkout entre Pix (com QR/comprovante) ou na entrega.
-- ============================================================

-- digital_channel_config: toggle do lojista
ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS pay_on_delivery_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN digital_channel_config.pay_on_delivery_enabled IS
  'Se true, storefront oferece "Pagar na entrega" como alternativa ao Pix.';

-- digital_orders: forma de pagamento que o cliente escolheu no checkout
ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'pix';

COMMENT ON COLUMN digital_orders.payment_method IS
  'Forma de pagamento escolhida pelo cliente: pix | on_delivery.';

-- Index parcial pra listar pedidos on_delivery rapidamente
CREATE INDEX IF NOT EXISTS digital_orders_on_delivery_idx
  ON digital_orders (company_id, status, created_at DESC)
  WHERE payment_method = 'on_delivery';
