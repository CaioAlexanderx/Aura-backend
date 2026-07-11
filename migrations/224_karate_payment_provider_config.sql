-- 224_karate_payment_provider_config.sql
-- Fase F5 (conciliação automática de pagamento) — provider configurável
-- POR FEDERAÇÃO, com fallback pro comportamento global atual (env
-- KARATE_PAYMENT_PROVIDER, default 'static_brcode').
--
-- Colunas aditivas nullable em digital_channel_config — sem nenhuma
-- delas preenchida, o provider resolvido continua 'static_brcode' e
-- o comportamento (PIX estático + confirmação manual) não muda.
--
-- Nomenclatura deliberadamente agnóstica de provedor (produto ainda não
-- fechou qual provedor concreto vai ligar isso em produção): o valor de
-- karate_payment_provider é uma string livre interpretada pelo backend
-- (services/karatePaymentProvider.js) — hoje só 'static_brcode' está
-- ativo por padrão.

ALTER TABLE digital_channel_config
  ADD COLUMN IF NOT EXISTS karate_payment_provider              TEXT,
  ADD COLUMN IF NOT EXISTS karate_payment_provider_api_key      TEXT,
  ADD COLUMN IF NOT EXISTS karate_payment_provider_base_url     TEXT,
  ADD COLUMN IF NOT EXISTS karate_payment_provider_webhook_secret TEXT;

COMMENT ON COLUMN digital_channel_config.karate_payment_provider IS
  'Override por federação de qual provider de pagamento usar pra anuidades karatê (ex.: static_brcode ou um provider dinâmico). NULL = usa o fallback global (env KARATE_PAYMENT_PROVIDER, default static_brcode).';
COMMENT ON COLUMN digital_channel_config.karate_payment_provider_api_key IS
  'Credencial (API key/token) do provider dinâmico configurado pra esta federação. NULL = usa o fallback de env do provider ativo.';
COMMENT ON COLUMN digital_channel_config.karate_payment_provider_base_url IS
  'Override opcional da URL base da API do provider dinâmico (multi-conta/multi-ambiente). NULL = usa o default do provider.';
COMMENT ON COLUMN digital_channel_config.karate_payment_provider_webhook_secret IS
  'Token/segredo usado pra validar POST /webhooks/karate-payments pra esta federação. NULL = valida contra o fallback global de env; se nenhum dos dois estiver configurado, o webhook não valida (mesmo comportamento hoje adotado pelos demais webhooks do projeto quando não há segredo configurado).';
