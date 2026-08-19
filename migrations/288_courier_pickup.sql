-- ============================================================
-- 288 — Retirada por app de entrega (Uber, 99, motoboy particular)
--
-- Terceiro modo de entrega, ao lado de 'pickup' e 'delivery': o CLIENTE
-- contrata o entregador e informa quem vai buscar. A loja nao cobra frete
-- (quem paga o app e o cliente) e nao precisa do endereco — precisa saber
-- para QUEM entregar o pacote no balcao.
--
-- Por isso os dois campos sao do entregador, nao do cliente: sem nome e
-- placa, a lojista entrega a personalizacao de alguem para o primeiro
-- motoboy que aparecer dizendo o numero do pedido.
--
-- delivery_type e TEXT sem CHECK constraint (verificado em 18/08/2026):
-- o valor 'courier' entra sem alterar dominio. Toda a base hoje tem
-- apenas 'pickup'.
--
-- courier_pickup_enabled nasce FALSE: a modalidade so aparece na loja
-- depois que a lojista liga, igual a delivery_enabled/pickup_enabled.
-- ============================================================

ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS courier_name  TEXT,
  ADD COLUMN IF NOT EXISTS courier_plate TEXT;

COMMENT ON COLUMN digital_orders.courier_name  IS
  'Nome do entregador que retira o pedido (delivery_type=courier). Informado pelo cliente.';
COMMENT ON COLUMN digital_orders.courier_plate IS
  'Placa do entregador, normalizada em caixa alta sem separador (ABC1234 ou ABC1D23).';

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS courier_pickup_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN digital_channel_config.courier_pickup_enabled IS
  'Loja aceita retirada por app de entrega (cliente contrata Uber/99 e informa nome + placa).';
