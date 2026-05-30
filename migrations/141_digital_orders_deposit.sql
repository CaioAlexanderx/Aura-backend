-- 141_digital_orders_deposit.sql
-- Studio Camada 1: Gate de produção por sinal (Fase C, 30/05/2026)
-- Decisão 7 do plano: pedido aceito vira order; produção só libera quando sinal pago.
-- Adiciona controle de depósito aos pedidos Studio em digital_orders.

ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS deposit_required numeric(12,2),
  ADD COLUMN IF NOT EXISTS deposit_paid     boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN digital_orders.deposit_required IS
  'Studio Camada 1: valor de sinal exigido antes de liberar produção. Null = sem sinal.';
COMMENT ON COLUMN digital_orders.deposit_paid IS
  'Studio Camada 1: TRUE quando sinal confirmado. Libera transição approved→in_production.';
