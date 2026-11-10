-- ============================================================
-- 443 — NFS-e: "Já emite NFS-e por outro emissor?" e conflito de numeração.
--
-- Por quê (incidente de 10/11/2026, produção): a loja já tinha emitido, por
-- outro emissor, uma DPS com a MESMA série (1) e o MESMO número (1) que a
-- Aura usou. A regra "a série da Aura nunca colide com a do emissor do
-- gov.br" (faixas do Anexo I) não vale na prática. A Aura passa a:
--   * perguntar no passo "série" se a loja já emite por outro emissor e,
--     se sim, a série e o último número usados nele (na mesma série, a Aura
--     continua a partir do número seguinte);
--   * guardar o conflito quando a emissão descobre que a série/número já
--     foram usados (DPS_NUMERO_JA_USADO): nenhuma nota nova gasta número
--     até a loja conferir a configuração.
--
-- Aditiva: só colunas novas, nulas, sem DEFAULT e sem backfill.
--
-- Caminho de volta (manual):
--   ALTER TABLE nfse_config
--     DROP COLUMN IF EXISTS outro_emissor,
--     DROP COLUMN IF EXISTS outro_emissor_serie,
--     DROP COLUMN IF EXISTS outro_emissor_ultimo_numero,
--     DROP COLUMN IF EXISTS dps_conflito_em,
--     DROP COLUMN IF EXISTS dps_conflito_serie,
--     DROP COLUMN IF EXISTS dps_conflito_numero;
-- ============================================================

ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS outro_emissor                boolean;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS outro_emissor_serie          varchar(5);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS outro_emissor_ultimo_numero  bigint;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS dps_conflito_em              timestamptz;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS dps_conflito_serie           varchar(5);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS dps_conflito_numero          bigint;

DO $$ BEGIN
  ALTER TABLE nfse_config ADD CONSTRAINT ck_nfse_config_outro_emissor_ultimo_numero
    CHECK (outro_emissor_ultimo_numero IS NULL OR outro_emissor_ultimo_numero >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN nfse_config.outro_emissor IS
  'Resposta da lojista: já emite NFS-e por outro emissor (site/app do gov.br ou outro sistema)? Nulo = ainda não respondeu.';
COMMENT ON COLUMN nfse_config.outro_emissor_serie IS
  'Série da DPS usada no outro emissor (só com outro_emissor = true).';
COMMENT ON COLUMN nfse_config.outro_emissor_ultimo_numero IS
  'Último Número da DPS usado no outro emissor, nessa série. Na mesma série da Aura, next_dps_number começa no seguinte.';
COMMENT ON COLUMN nfse_config.dps_conflito_em IS
  'Quando a emissão descobriu que a série/número da DPS já foram usados por outro emissor (DPS_NUMERO_JA_USADO). Enquanto preenchido, nenhuma nota nova gasta número. Limpo quando a lojista confirma a série.';
COMMENT ON COLUMN nfse_config.dps_conflito_serie IS
  'Série da DPS em conflito (dps_conflito_em).';
COMMENT ON COLUMN nfse_config.dps_conflito_numero IS
  'Número da DPS em conflito (dps_conflito_em).';
