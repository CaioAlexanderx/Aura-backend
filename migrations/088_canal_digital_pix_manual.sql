-- ============================================================
-- 088_canal_digital_pix_manual.sql
-- AURA. — Canal Digital: substituir Asaas pelo Pix manual
--
-- Adiciona suporte a:
--   * Lojista cadastrar chave Pix propria (sem KYC Asaas)
--   * Cliente final anexar comprovante de pagamento
--   * Status do pedido "awaiting_approval" (com payment_proof_url)
--
-- NOTA: O partial index com WHERE status = 'awaiting_approval' foi
-- movido pra migration 090, porque em CI/DB novo o enum
-- digital_order_status (criado em 070) nao tem esse valor e o index
-- explodia. 090 adiciona o valor ao enum E cria o index.
-- ============================================================

-- digital_channel_config: campos da chave Pix do lojista
ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS pix_key          TEXT,
  ADD COLUMN IF NOT EXISTS pix_key_type     TEXT,    -- CPF | CNPJ | EMAIL | PHONE | RANDOM
  ADD COLUMN IF NOT EXISTS pix_holder_name  TEXT,
  ADD COLUMN IF NOT EXISTS pix_holder_city  TEXT;

COMMENT ON COLUMN digital_channel_config.pix_key IS
  'Chave Pix do lojista pra recebimento manual (sem subconta Asaas).';
COMMENT ON COLUMN digital_channel_config.pix_key_type IS
  'Tipo da chave Pix: CPF, CNPJ, EMAIL, PHONE ou RANDOM.';
COMMENT ON COLUMN digital_channel_config.pix_holder_name IS
  'Nome do recebedor (max 25 chars apos sanitize) — vai no BR Code.';
COMMENT ON COLUMN digital_channel_config.pix_holder_city IS
  'Cidade do recebedor (max 15 chars apos sanitize) — vai no BR Code.';

-- digital_orders: anexar comprovante de pagamento enviado pelo cliente
ALTER TABLE digital_orders
  ADD COLUMN IF NOT EXISTS payment_proof_url         TEXT,
  ADD COLUMN IF NOT EXISTS payment_proof_uploaded_at TIMESTAMPTZ;

COMMENT ON COLUMN digital_orders.payment_proof_url IS
  'URL do comprovante de Pix enviado pelo cliente (R2). Opcional, mas usado pra agilizar aprovacao manual.';
COMMENT ON COLUMN digital_orders.payment_proof_uploaded_at IS
  'Timestamp do upload do comprovante.';

-- O CREATE INDEX digital_orders_awaiting_approval_idx foi movido pra
-- migration 090 (depende do enum aceitar 'awaiting_approval').
