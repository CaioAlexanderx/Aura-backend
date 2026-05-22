-- Fase 10: Hub de Pedidos -- campo de rastreio de canal externo
--
-- food_orders ja tem 'channel' (presencial/delivery_proprio/ifood/whatsapp/online).
-- 128 adiciona campos pra rastreio de external IDs (iFood/99food order id remoto)
-- + metadata JSONB pra payload completo do canal (debug + reprocesso).
--
-- Idempotente: IF NOT EXISTS em coluna e indice; ON CONFLICT nao aplicavel aqui.

ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS external_order_id TEXT,
  ADD COLUMN IF NOT EXISTS external_channel TEXT,  -- ifood | 99food | whatsapp | canal_digital | presencial | uber_eats (futuro)
  ADD COLUMN IF NOT EXISTS channel_metadata JSONB,
  ADD COLUMN IF NOT EXISTS auto_accepted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_food_orders_external_channel
  ON food_orders(company_id, external_channel)
  WHERE external_channel IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_food_orders_external_order_id
  ON food_orders(external_order_id)
  WHERE external_order_id IS NOT NULL;

-- digital_orders ja tem campos proprios (TabPedidos consume direto); nada a fazer aqui.
-- Quando iFood/99food API aprovarem, INSERTs reais usam external_channel = 'ifood'/'99food'
-- + external_order_id = id remoto + channel_metadata = payload bruto.
