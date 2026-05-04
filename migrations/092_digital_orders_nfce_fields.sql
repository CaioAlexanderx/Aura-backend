-- ============================================================
-- 092_digital_orders_nfce_fields.sql
-- AURA. — Canal Digital: campos pra emissao automatica de NFCe
--
-- Coletados no checkout pra alimentar nfce_emissions:
--   * customer_cpf_cnpj — opcional, "CPF na nota"
--   * nfce_requested    — flag (cliente marcou checkbox)
--   * nfce_id           — FK pra nfce_emissions (preenche apos emissao)
--   * address_*         — endereco estruturado (substitui delivery_address text)
-- ============================================================

ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS customer_cpf_cnpj      TEXT,
  ADD COLUMN IF NOT EXISTS nfce_requested         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS nfce_id                UUID REFERENCES nfce_emissions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS address_zip            TEXT,
  ADD COLUMN IF NOT EXISTS address_street         TEXT,
  ADD COLUMN IF NOT EXISTS address_number         TEXT,
  ADD COLUMN IF NOT EXISTS address_complement     TEXT,
  ADD COLUMN IF NOT EXISTS address_neighborhood   TEXT,
  ADD COLUMN IF NOT EXISTS address_city           TEXT,
  ADD COLUMN IF NOT EXISTS address_state          CHAR(2);

COMMENT ON COLUMN digital_orders.customer_cpf_cnpj IS
  'CPF (11) ou CNPJ (14) do cliente, so digitos. Opcional, usado pra NFCe nominal.';
COMMENT ON COLUMN digital_orders.nfce_requested IS
  'Cliente marcou checkbox "Quero CPF na nota" no checkout.';
COMMENT ON COLUMN digital_orders.nfce_id IS
  'NFCe emitida pra esse pedido. NULL ate pedido confirmar OU se NFCe nao configurada.';
