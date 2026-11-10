-- ============================================================
-- AURA. — Migration 436: Recebe na Aura — subconta Asaas POR EMPRESA (RA-05)
-- company_baas_accounts
-- ------------------------------------------------------------
-- 10/11/2026. Primeiro passo do BaaS do dojô (244, karate_dojo_baas_accounts)
-- para o varejo. Modelo A: a Asaas presta o serviço, a Aura integra.
--
-- Uma linha por EMPRESA (company_id): cada CNPJ do grupo tem a sua subconta;
-- nunca uma por grupo. O dinheiro vai da Asaas direto para a subconta da
-- lojista e nunca passa pela conta da Aura; o split para a carteira da Aura
-- entra em cada cobrança (RA-07). Inadimplência é da lojista.
--
-- Espelha o que a 244 guarda (id da conta, wallet, agência/conta, apiKey
-- CIFRADA, status do onboarding, link de onboarding, hash do token de
-- webhook, snapshot do KYC) e acrescenta o tipo de titular (PJ/PF/MEI), a
-- política de notificação ao cliente final e quem pediu a criação.
--
-- Feature flag RECEBE_NA_AURA_ENABLED (env, default OFF): sem ela nenhuma
-- linha é criada aqui. Não mexe nas tabelas do karatê. Sem backfill (as
-- colunas legadas companies.asaas_subconta_* não são copiadas).
--
-- Idempotente: IF NOT EXISTS + constraints em DO $$ (padrão da 244).
-- ============================================================

CREATE TABLE IF NOT EXISTS company_baas_accounts (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      uuid NOT NULL,
  holder_type                     text NOT NULL DEFAULT 'PJ',
  asaas_account_id                text,
  api_key_enc                     text,
  wallet_id                       text,
  agency                          text,
  account                         text,
  account_digit                   text,
  status                          text NOT NULL DEFAULT 'creating',
  onboarding_url                  text,
  webhook_token_hash              text,
  customer_notifications_disabled boolean NOT NULL DEFAULT true,
  kyc_snapshot                    jsonb,
  created_by                      uuid,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now()
);

-- Uma subconta por empresa (também é o que torna a criação idempotente:
-- INSERT ... ON CONFLICT (company_id) DO NOTHING reserva a linha).
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_baas_accounts_company
  ON company_baas_accounts (company_id);

-- A mesma conta Asaas nunca fica presa a duas empresas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_baas_accounts_asaas_account
  ON company_baas_accounts (asaas_account_id)
  WHERE asaas_account_id IS NOT NULL;

-- Lookup do webhook (RA-07) por hash do token da subconta.
CREATE INDEX IF NOT EXISTS idx_company_baas_accounts_webhook_token_hash
  ON company_baas_accounts (webhook_token_hash)
  WHERE webhook_token_hash IS NOT NULL;

-- RESTRICT (e não CASCADE como na 244): apagar a empresa não pode levar junto
-- a única cópia da chave de uma subconta que tem dinheiro da lojista.
DO $$ BEGIN
  ALTER TABLE company_baas_accounts
    ADD CONSTRAINT company_baas_accounts_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE company_baas_accounts
    ADD CONSTRAINT company_baas_accounts_status_check
    CHECK (status IN ('creating', 'created', 'docs_pending', 'under_review', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE company_baas_accounts
    ADD CONSTRAINT company_baas_accounts_holder_type_check
    CHECK (holder_type IN ('PJ', 'PF', 'MEI'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TABLE company_baas_accounts IS
  'Recebe na Aura (RA-05): subconta Asaas por empresa (uma por company_id/CNPJ). O dinheiro vai da Asaas direto para a subconta da lojista, nunca pela conta da Aura; split para a Aura em cada cobrança. Atrás da flag RECEBE_NA_AURA_ENABLED.';
COMMENT ON COLUMN company_baas_accounts.api_key_enc IS
  'apiKey da subconta CIFRADA (AES-256-GCM, dojoBaasCrypto, env DOJO_BAAS_ENC_KEY). Nunca em texto puro, nunca no log, nunca na resposta da API. A Asaas exibe a apiKey uma vez só, na criação.';
COMMENT ON COLUMN company_baas_accounts.status IS
  'creating (linha reservada, aguardando a Asaas) → created → docs_pending → under_review → approved | rejected. creating parado = resposta ambígua da Asaas: conferir antes de tentar de novo.';
COMMENT ON COLUMN company_baas_accounts.holder_type IS
  'Titular da subconta: PJ (padrão), PF ou MEI.';
COMMENT ON COLUMN company_baas_accounts.webhook_token_hash IS
  'SHA-256 do authToken do webhook da subconta (RA-07). Só o hash; o token cru vai só para a Asaas.';
COMMENT ON COLUMN company_baas_accounts.customer_notifications_disabled IS
  'true = a Asaas não notifica o cliente final (notificationDisabled em todo cliente criado na subconta); quem avisa é a Aura.';
COMMENT ON COLUMN company_baas_accounts.kyc_snapshot IS
  'Dados do titular enviados na criação da subconta (sem dados de cartão). Auditoria/reenvio.';
