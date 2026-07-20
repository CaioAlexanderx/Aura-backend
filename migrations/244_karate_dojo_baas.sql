-- ============================================================
-- AURA DOJÔ — Migration 244: Conta Aura do dojô (BaaS Asaas, F3b, OPT-IN)
-- karate_dojo_baas_accounts
-- ------------------------------------------------------------
-- NUMERAÇÃO: 240 (owner-invites), 241 (card_queue_out_of_queue + tombstone
-- 241_karate_dojo_students), 242 (karate_dojo_students, F2) e 243 (motor de
-- mensalidades, F3a) já tomados — esta é a 244. Convenção CLAUDE.md:
-- numeração sequencial, incrementar.
--
-- DECISÃO CENTRAL (F3b Aura Dojô, 19/07/2026): a "Conta Aura do dojô" é uma
-- SUBCONTA Asaas (antigo White Label) criada pela conta-mãe PJ da Aura, e é
-- estritamente OPT-IN. O dojô ESCOLHE (karate_dojo_billing/baas/provider)
-- entre:
--   • 'pix_manual'  — chave PIX própria do dojô (F3a; DEFAULT eterno), e
--   • 'baas'        — recebe pela subconta Asaas desta tabela (só após
--                     status='approved').
-- Nunca forçado: sem registro aqui, o dojô continua 100% em pix_manual.
--
-- MARGEM AURA = SPLIT fixo de 0,5% pra wallet da conta-mãe em cada cobrança
-- PIX criada via subconta (env ASAAS_DOJO_MOTHER_WALLET_ID). A subconta
-- guarda a apiKey CIFRADA (AES-256-GCM, dojoBaasCrypto — env
-- DOJO_BAAS_ENC_KEY); NUNCA em texto puro. accountNumber (agência/conta/
-- dígito) e walletId vêm da criação e são exibidos ao dojô.
--
-- FEATURE FLAG DOJO_BAAS_ENABLED (env, default OFF): todo o fluxo BaaS está
-- atrás dela por causa da HOMOLOGAÇÃO regulatória Asaas pendente (período
-- de avaliação: 10 subcontas / R$2.000 por subconta / 60 dias — estourar
-- CANCELA as assinaturas). Com a flag OFF nada muda em produção: o billing
-- (F3a) segue funcionando em pix_manual e a ativação responde 503.
--
-- Res. Conjunta 16/17: a subconta é criada pela conta-mãe PJ; o front exibe
-- a identificação da Asaas como prestadora (fora do escopo desta migration).
--
-- NÃO aplicada em produção neste PR (aplicar via MCP antes do deploy).
-- Idempotente / defensiva (IF NOT EXISTS + constraints em DO $$), padrão
-- das migrations 240/242/243.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_baas_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id            uuid NOT NULL,
  asaas_account_id   text,
  api_key_enc        text,
  wallet_id          text,
  agency             text,
  account            text,
  account_digit      text,
  status             text NOT NULL DEFAULT 'created',
  onboarding_url     text,
  webhook_token_hash text,
  provider_selected  text NOT NULL DEFAULT 'pix_manual',
  kyc_snapshot       jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Um registro por dojô (a subconta é única por company do dojô).
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_dojo_baas_accounts_dojo
  ON karate_dojo_baas_accounts (dojo_id);

-- Lookup do webhook público por hash do token da subconta.
CREATE INDEX IF NOT EXISTS idx_karate_dojo_baas_accounts_webhook_token_hash
  ON karate_dojo_baas_accounts (webhook_token_hash);

DO $$ BEGIN
  ALTER TABLE karate_dojo_baas_accounts
    ADD CONSTRAINT karate_dojo_baas_accounts_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_baas_accounts
    ADD CONSTRAINT karate_dojo_baas_accounts_status_check
    CHECK (status IN ('created', 'docs_pending', 'under_review', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_baas_accounts
    ADD CONSTRAINT karate_dojo_baas_accounts_provider_selected_check
    CHECK (provider_selected IN ('pix_manual', 'baas'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── COMMENTs (modelo) ──
COMMENT ON TABLE karate_dojo_baas_accounts IS
  'F3b Aura Dojô: Conta Aura do dojô = SUBCONTA Asaas (White Label), OPT-IN. Um registro por dojô. Atrás da feature flag DOJO_BAAS_ENABLED (homologação regulatória Asaas pendente: 10 subcontas / R$2.000 por subconta / 60 dias). Margem Aura = split fixo de 0,5% pra wallet da conta-mãe (env ASAAS_DOJO_MOTHER_WALLET_ID) em cada cobrança PIX criada via subconta.';
COMMENT ON COLUMN karate_dojo_baas_accounts.api_key_enc IS
  'apiKey da subconta CIFRADA (AES-256-GCM, dojoBaasCrypto, env DOJO_BAAS_ENC_KEY). NUNCA armazenada/logada em texto puro. A Asaas exibe a apiKey UMA vez na criação.';
COMMENT ON COLUMN karate_dojo_baas_accounts.webhook_token_hash IS
  'SHA-256 do authToken do webhook da subconta (asaas-access-token). O token cru só é enviado à Asaas na criação; aqui guardamos só o hash pra autenticar o webhook público /webhooks/asaas-dojo.';
COMMENT ON COLUMN karate_dojo_baas_accounts.status IS
  'Onboarding da subconta: created → docs_pending → under_review → approved | rejected. Só approved habilita provider_selected=baas. approved nunca é rebaixado por evento fora de ordem (só rejected pode sobrescrever).';
COMMENT ON COLUMN karate_dojo_baas_accounts.provider_selected IS
  'Recebedor efetivo do dojô: pix_manual (chave própria, F3a — DEFAULT) ou baas (subconta Asaas). baas só é aceito com status=approved.';
COMMENT ON COLUMN karate_dojo_baas_accounts.kyc_snapshot IS
  'Snapshot dos dados de KYC enviados na criação da subconta (sem dados de cartão). Auditoria/reenvio.';
