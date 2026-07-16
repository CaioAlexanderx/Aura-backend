-- ============================================================
-- AURA. — Migration 234 (ex-173): Emissão própria de NFC-e (SEFAZ-SP) — S1.1
-- Roadmap NFC-e própria v1, Sessão 1.
--
-- 1. nfce_config: provider plugável ('nuvemfiscal'|'focusnfe'|'sefaz_sp')
--    + fallback_provider + csc_token_enc (AES-256-GCM, backfill via
--    scripts/encrypt-nfce-secrets.js — csc_token em claro será NULLado
--    pelo script após cifrar).
-- 2. company_certificates: certificado A1 (.pfx) cifrado AES-256-GCM.
--    Chave-mestra em env.CERT_MASTER_KEY (fora do banco). NUNCA logar.
-- 3. nfce_emissions: campos da emissão própria (xml assinado, tpEmis,
--    contingência, retransmissão, código de rejeição).
--
-- NOTA certificate_password_hash (032): coluna VESTIGIAL — nunca foi
-- lida/escrita pelo código (o .pfx vai pro gateway sem ser armazenado).
-- Não há dados a migrar; fica deprecada via COMMENT. Idem certificate_file.
-- Idempotente.
-- ============================================================

-- ===== 1. nfce_config =====

ALTER TABLE nfce_config
  ADD COLUMN IF NOT EXISTS provider          VARCHAR(20) NOT NULL DEFAULT 'nuvemfiscal',
  ADD COLUMN IF NOT EXISTS fallback_provider VARCHAR(20),
  ADD COLUMN IF NOT EXISTS csc_token_enc     TEXT;

DO $$ BEGIN
  ALTER TABLE nfce_config
    ADD CONSTRAINT chk_nfce_config_provider
    CHECK (provider IN ('nuvemfiscal','focusnfe','sefaz_sp'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE nfce_config
    ADD CONSTRAINT chk_nfce_config_fallback_provider
    CHECK (fallback_provider IS NULL
           OR fallback_provider IN ('nuvemfiscal','focusnfe','sefaz_sp'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Fallback não pode ser o próprio primário
DO $$ BEGIN
  ALTER TABLE nfce_config
    ADD CONSTRAINT chk_nfce_config_fallback_distinct
    CHECK (fallback_provider IS NULL OR fallback_provider <> provider);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN nfce_config.provider          IS 'Provider de emissão: nuvemfiscal | focusnfe | sefaz_sp (emissão própria)';
COMMENT ON COLUMN nfce_config.fallback_provider IS 'Provider secundário usado pelo circuit breaker (S4.2) quando o primário falha';
COMMENT ON COLUMN nfce_config.csc_token_enc     IS 'CSC token cifrado AES-256-GCM (envelope v1:iv:tag:cipher, base64). Chave em env.CERT_MASTER_KEY';
COMMENT ON COLUMN nfce_config.csc_token         IS 'DEPRECATED: em claro. Após backfill (scripts/encrypt-nfce-secrets.js) fica NULL; usar csc_token_enc';
COMMENT ON COLUMN nfce_config.certificate_file  IS 'DEPRECATED: nunca usada pelo código. Certificado próprio vive em company_certificates';
COMMENT ON COLUMN nfce_config.certificate_password_hash IS 'DEPRECATED: vestigial, nunca lida/escrita. Senha cifrada (reversível) vive em company_certificates.password_enc';

-- ===== 2. company_certificates =====

CREATE TABLE IF NOT EXISTS company_certificates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  pfx_enc      BYTEA NOT NULL,           -- ciphertext || authTag (16 bytes finais), AES-256-GCM
  pfx_iv       BYTEA NOT NULL,           -- IV 12 bytes
  password_enc TEXT  NOT NULL,           -- senha do .pfx cifrada (envelope v1:iv:tag:cipher)
  not_after    TIMESTAMPTZ,              -- validade do certificado (alerta de expiração)
  not_before   TIMESTAMPTZ,
  subject_cn   TEXT,                     -- CN do titular (exibição; sem dados sensíveis)
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  company_certificates IS 'Certificados A1 (.pfx) sob guarda própria, cifrados AES-256-GCM. Chave-mestra FORA do banco (env.CERT_MASTER_KEY). Nunca logar conteúdo; nunca persistir .pfx em disco';
COMMENT ON COLUMN company_certificates.not_after IS 'Validade: alimenta alerta de expiração 30/15/7 dias (S3.3/S4.1)';

CREATE INDEX IF NOT EXISTS idx_company_certificates_not_after
  ON company_certificates(not_after);

-- ===== 3. nfce_emissions =====

ALTER TABLE nfce_emissions
  ADD COLUMN IF NOT EXISTS xml_signed     TEXT,
  ADD COLUMN IF NOT EXISTS tp_emis        SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS contingency_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS transmitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_code VARCHAR(8);

COMMENT ON COLUMN nfce_emissions.xml_signed     IS 'XML da NFC-e assinado (emissão própria). Fonte da retransmissão em contingência';
COMMENT ON COLUMN nfce_emissions.tp_emis        IS '1=normal, 9=contingência offline NFC-e';
COMMENT ON COLUMN nfce_emissions.contingency_at IS 'Momento em que a nota entrou em contingência (dhCont)';
COMMENT ON COLUMN nfce_emissions.transmitted_at IS 'Momento da transmissão aceita pela SEFAZ (difere de authorized_at em contingência)';
COMMENT ON COLUMN nfce_emissions.rejection_code IS 'cStat de rejeição da SEFAZ (catálogo amigável S2.2)';

-- Mineração do catálogo S2.2 e telemetria S3.3
CREATE INDEX IF NOT EXISTS idx_nfce_emissions_rejection
  ON nfce_emissions(company_id, rejection_code)
  WHERE rejection_code IS NOT NULL;
