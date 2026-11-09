-- ============================================================
-- 429 — NFS-e pelo Emissor Público Nacional (API Sefin Nacional), PR 1 de 3.
--
-- Por quê: Resolução CGSN 191/2026 — desde 01/11/2026 ME/EPP do Simples
-- emitem NFS-e pelo Emissor Nacional; Jacareí-SP só usa o Emissor Nacional
-- desde 15/12/2025. O provider 'nacional' (src/services/nfseNacional) usa
-- as tabelas que já existem desde a 058 (nfse_config e nfse, 0 linhas em
-- 09/11/2026) com colunas NOVAS — nada existente muda de sentido.
--
-- Tudo idempotente. Mudanças que não são "ADD COLUMN":
--   * nfse_config.ambiente varchar(15) -> varchar(20): cabe 'producao_restrita'
--     (alargar varchar não reescreve a tabela);
--   * nfse.rps_number e nfse.recipient_name deixam de ser NOT NULL: a nota
--     nacional não tem RPS (tem DPS, colunas próprias) e o tomador é opcional
--     no leiaute. As rotas antigas continuam gravando os dois.
--
-- Caminho de volta (manual, só se nenhuma nota nacional tiver sido gravada):
--   DROP INDEX IF EXISTS uq_nfse_idempotency, uq_nfse_dps, uq_nfse_chave_acesso;
--   ALTER TABLE nfse DROP COLUMN IF EXISTS idempotency_key, DROP COLUMN IF EXISTS idempotency_fingerprint,
--     DROP COLUMN IF EXISTS ambiente, DROP COLUMN IF EXISTS dps_serie, DROP COLUMN IF EXISTS dps_number,
--     DROP COLUMN IF EXISTS dps_id, DROP COLUMN IF EXISTS dps_dados, DROP COLUMN IF EXISTS chave_acesso,
--     DROP COLUMN IF EXISTS xml_dps, DROP COLUMN IF EXISTS xml_nfse, DROP COLUMN IF EXISTS error_codes,
--     DROP COLUMN IF EXISTS transmitted_at, DROP COLUMN IF EXISTS cancel_event_xml;
--   ALTER TABLE nfse_config DROP COLUMN IF EXISTS municipio_ibge, DROP COLUMN IF EXISTS ctribnac_padrao,
--     DROP COLUMN IF EXISTS cnbs_padrao, DROP COLUMN IF EXISTS op_simp_nac, DROP COLUMN IF EXISTS reg_ap_trib_sn,
--     DROP COLUMN IF EXISTS reg_esp_trib, DROP COLUMN IF EXISTS p_tot_trib_sn, DROP COLUMN IF EXISTS next_dps_number;
--   (os NOT NULL e o varchar(15) só voltam se não houver linha que os viole)
-- ============================================================

-- ── 1. nfse_config: dados do emissor nacional ───────────────
ALTER TABLE nfse_config ALTER COLUMN ambiente TYPE varchar(20);

ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS municipio_ibge   varchar(7);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS ctribnac_padrao  varchar(6);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS cnbs_padrao      varchar(9);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS op_simp_nac      smallint;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS reg_ap_trib_sn   smallint;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS reg_esp_trib     smallint NOT NULL DEFAULT 0;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS p_tot_trib_sn    numeric(5, 2);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS next_dps_number  bigint   NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE nfse_config ADD CONSTRAINT ck_nfse_config_op_simp_nac
    CHECK (op_simp_nac IS NULL OR op_simp_nac IN (1, 2, 3));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE nfse_config ADD CONSTRAINT ck_nfse_config_reg_ap_trib_sn
    CHECK (reg_ap_trib_sn IS NULL OR reg_ap_trib_sn IN (1, 2, 3));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE nfse_config ADD CONSTRAINT ck_nfse_config_next_dps_number
    CHECK (next_dps_number >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN nfse_config.municipio_ibge IS
  'Emissor nacional: código IBGE (7) do município emissor (cLocEmi da DPS). Jacareí-SP = 3524402.';
COMMENT ON COLUMN nfse_config.ctribnac_padrao IS
  'Emissor nacional: código de tributação nacional padrão (6 dígitos, lista nacional / LC 116).';
COMMENT ON COLUMN nfse_config.op_simp_nac IS
  'Emissor nacional: 1 não optante, 2 MEI, 3 ME/EPP. Nulo = deduz de regime_tributario/optante_simples_nacional.';
COMMENT ON COLUMN nfse_config.reg_ap_trib_sn IS
  'Emissor nacional: regime de apuração do ME/EPP (1 tudo pelo SN; 2 ISSQN fora; 3 federais e ISSQN fora). Nulo = 1 para ME/EPP.';
COMMENT ON COLUMN nfse_config.p_tot_trib_sn IS
  'Emissor nacional: percentual aproximado dos tributos do Simples (pTotTribSN, Lei 12.741). Obrigatório para ME/EPP.';
COMMENT ON COLUMN nfse_config.next_dps_number IS
  'Emissor nacional: próximo número da DPS na série (serie). Reservado em transação junto com a nota; nunca volta.';

-- ── 2. nfse: rastro de cada emissão nacional ────────────────
ALTER TABLE nfse ALTER COLUMN rps_number     DROP NOT NULL;
ALTER TABLE nfse ALTER COLUMN recipient_name DROP NOT NULL;

ALTER TABLE nfse ADD COLUMN IF NOT EXISTS idempotency_key         varchar(120);
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS idempotency_fingerprint varchar(64);
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS ambiente                varchar(20);
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS dps_serie               varchar(5);
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS dps_number              bigint;
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS dps_id                  varchar(45);
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS dps_dados               jsonb;
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS chave_acesso            varchar(50);
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS xml_dps                 text;
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS xml_nfse                text;
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS error_codes             jsonb;
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS transmitted_at          timestamptz;
ALTER TABLE nfse ADD COLUMN IF NOT EXISTS cancel_event_xml        text;

-- Índices únicos TOTAIS (não parciais): NULL não colide no Postgres, então
-- as notas dos providers antigos (sem estas colunas) passam livres.
CREATE UNIQUE INDEX IF NOT EXISTS uq_nfse_idempotency
  ON nfse(company_id, idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_nfse_dps
  ON nfse(company_id, dps_serie, dps_number);
CREATE UNIQUE INDEX IF NOT EXISTS uq_nfse_chave_acesso
  ON nfse(chave_acesso);

COMMENT ON COLUMN nfse.idempotency_key IS
  'Chave do chamador: a mesma chave nunca gera duas notas (UNIQUE por empresa).';
COMMENT ON COLUMN nfse.dps_number IS
  'Emissor nacional: número da DPS reservado em nfse_config.next_dps_number. Retomadas usam o MESMO número.';
COMMENT ON COLUMN nfse.transmitted_at IS
  'Emissor nacional: gravado ANTES do POST ao Sefin. Preenchido + status pendente = consultar a DPS antes de reenviar.';
COMMENT ON COLUMN nfse.status IS
  'pendente | processando | autorizada | rejeitada | cancelada | erro (erro = falha nossa antes/fora do processamento fiscal).';
