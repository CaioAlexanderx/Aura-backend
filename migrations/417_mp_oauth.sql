-- Migration 417: Mercado Pago por OAuth (tq-94, 29/10/2026)
--
-- A lojista conecta o Mercado Pago por um botão (OAuth) em vez de colar
-- token, chave pública e segredo. Mesma tabela companies_payment_gateways,
-- um registro por empresa (multi-CNPJ: cada CNPJ conecta a sua conta).
--
--   auth_method        'manual' (token colado, como sempre foi) ou 'oauth'
--   refresh_token      cifrado (utils/secretCrypto, envelope v1:...)
--   token_expires_at   validade do access_token (180 dias no Mercado Pago)
--   mp_user_id         id do vendedor no Mercado Pago (webhook resolve a loja por ele, tq-95)
--   mp_nickname        nome da conta para "Conectado como"
--   connection_status  'ok' ou 'caiu' (autorização retirada ou inválida)
--   connection_lost_at quando caiu (chave do e-mail "a conexão caiu", tq-109)
--   last_checked_at    última checagem diária do acesso
--   connected_by       usuário que conectou
--
-- No OAuth, access_token também vai cifrado (a coluna é NOT NULL e já existe).
-- Registros manuais seguem em texto, como antes. Tabela vazia em 29/10/2026.
-- Idempotente.

-- A tabela foi criada à mão em 20/05/2026 (Fase 0) e nunca entrou em
-- migrations/; o CI monta o banco do zero por esta pasta. Em produção este
-- CREATE é no-op (mesma forma conferida em 29/10/2026).
CREATE TABLE IF NOT EXISTS companies_payment_gateways (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  gateway        TEXT NOT NULL CHECK (gateway = 'mercadopago'),
  access_token   TEXT NOT NULL,
  public_key     TEXT NOT NULL,
  sandbox        BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  webhook_secret TEXT,
  UNIQUE (company_id, gateway)
);

ALTER TABLE companies_payment_gateways
  ADD COLUMN IF NOT EXISTS auth_method        TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS refresh_token      TEXT,
  ADD COLUMN IF NOT EXISTS token_expires_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS mp_user_id         TEXT,
  ADD COLUMN IF NOT EXISTS mp_nickname        TEXT,
  ADD COLUMN IF NOT EXISTS connection_status  TEXT NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS connection_lost_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_checked_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS connected_by       UUID;

DO $$ BEGIN
  ALTER TABLE companies_payment_gateways
    ADD CONSTRAINT companies_payment_gateways_auth_method_check
    CHECK (auth_method IN ('manual', 'oauth'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE companies_payment_gateways
    ADD CONSTRAINT companies_payment_gateways_connection_status_check
    CHECK (connection_status IN ('ok', 'caiu'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Webhook único da aplicação: resolve a loja pelo user_id do vendedor.
-- Não é único: a mesma conta do Mercado Pago pode servir dois CNPJs do grupo.
CREATE INDEX IF NOT EXISTS idx_cpg_mp_user_id
  ON companies_payment_gateways (mp_user_id)
  WHERE mp_user_id IS NOT NULL;

-- Checagem diária: só as conexões por OAuth.
CREATE INDEX IF NOT EXISTS idx_cpg_oauth_expira
  ON companies_payment_gateways (token_expires_at)
  WHERE auth_method = 'oauth';

COMMENT ON COLUMN companies_payment_gateways.auth_method IS
  'manual = token colado pela lojista; oauth = conectado pelo botão (tokens cifrados com CERT_MASTER_KEY).';
COMMENT ON COLUMN companies_payment_gateways.connection_status IS
  'ok ou caiu. Com caiu o checkout não oferece cartão nem Pix do Mercado Pago (services/mpGateway).';
