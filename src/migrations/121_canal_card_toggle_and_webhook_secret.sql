-- Migration 121: toggle card no canal digital + webhook secret por gateway
-- Aplicada via Supabase MCP em 21/05/2026 (backend nao roda migrations auto no boot)
-- Idempotente (IF NOT EXISTS) — seguro re-rodar.

-- 1. digital_channel_config.card_enabled — toggle independente das credenciais MP.
--    Default true porque ja existem instalacoes com MP cadastrado que esperam
--    cartao habilitado. Quando false, has_card vira false mesmo com credenciais.
ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS card_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN digital_channel_config.card_enabled IS
  'Toggle independente p/ aceitar cartao no checkout (separado das credenciais MP). Default true. Quando false, has_card vira false mesmo com credenciais cadastradas.';

-- 2. companies_payment_gateways.webhook_secret — chave HMAC do webhook MP.
--    Opcional. Quando preenchido, webhookMp.js valida x-signature via HMAC-SHA256.
--    Quando NULL, mantem fallback legado (consulta /v1/payments antes de confirmar).
ALTER TABLE companies_payment_gateways
  ADD COLUMN IF NOT EXISTS webhook_secret TEXT;

COMMENT ON COLUMN companies_payment_gateways.webhook_secret IS
  'Chave secreta do webhook MP (Painel Desenvolvedor MP -> Webhooks -> Configuracao de chave secreta). Quando presente, x-signature e validado via HMAC-SHA256.';
