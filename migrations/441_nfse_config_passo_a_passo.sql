-- ============================================================
-- 441 — NFS-e: configuração da loja passo a passo e nota de teste.
--
-- Por quê: hoje só a equipe configura a NFS-e (nfse_config), então nenhuma
-- loja liga a nota de serviço sozinha. A tela "Pronto para emitir NFS-e?"
-- (aba Emitir NFS-e de Notas fiscais) precisa guardar o que a lojista
-- respondeu e o resultado da nota de teste em produção restrita:
--   * alíquota efetiva do ISSQN no Simples, só para quem tem cliente que
--     retém (NUNCA vem preenchida: sem DEFAULT, sem backfill);
--   * se algum cliente retém o ISSQN (nulo = ainda não respondeu);
--   * o último teste (quando, ok/rejeitado/erro, código do gov.br, texto,
--     id da nota de teste) — base para um teste diário futuro;
--   * se a prefeitura já incluiu a empresa no Cadastro Nacional de
--     Contribuintes da NFS-e (CNC);
--   * quando a lojista confirmou a Série/Número da DPS;
--   * contador próprio da série de teste (49999): o teste nunca gasta a
--     numeração da série de verdade da loja.
--
-- Aditiva: só colunas novas (nulas ou com DEFAULT constante), sem backfill.
--
-- Caminho de volta (manual):
--   ALTER TABLE nfse_config
--     DROP COLUMN IF EXISTS aliquota_iss_retencao_sn,
--     DROP COLUMN IF EXISTS cliente_retem_iss,
--     DROP COLUMN IF EXISTS ultimo_teste_em,
--     DROP COLUMN IF EXISTS ultimo_teste_status,
--     DROP COLUMN IF EXISTS ultimo_teste_codigo,
--     DROP COLUMN IF EXISTS ultimo_teste_mensagem,
--     DROP COLUMN IF EXISTS ultimo_teste_nfse_id,
--     DROP COLUMN IF EXISTS prefeitura_cadastro_confirmado,
--     DROP COLUMN IF EXISTS serie_confirmada_em,
--     DROP COLUMN IF EXISTS teste_next_dps_number;
-- ============================================================

ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS aliquota_iss_retencao_sn       numeric(5, 2);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS cliente_retem_iss              boolean;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS ultimo_teste_em                timestamptz;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS ultimo_teste_status            varchar(10);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS ultimo_teste_codigo            varchar(20);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS ultimo_teste_mensagem          text;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS ultimo_teste_nfse_id           uuid;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS prefeitura_cadastro_confirmado varchar(8);
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS serie_confirmada_em            timestamptz;
ALTER TABLE nfse_config ADD COLUMN IF NOT EXISTS teste_next_dps_number          bigint NOT NULL DEFAULT 1;

DO $$ BEGIN
  ALTER TABLE nfse_config ADD CONSTRAINT ck_nfse_config_aliquota_iss_retencao_sn
    CHECK (aliquota_iss_retencao_sn IS NULL OR (aliquota_iss_retencao_sn >= 1.80 AND aliquota_iss_retencao_sn <= 5.00));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE nfse_config ADD CONSTRAINT ck_nfse_config_ultimo_teste_status
    CHECK (ultimo_teste_status IS NULL OR ultimo_teste_status IN ('ok', 'rejeitado', 'erro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE nfse_config ADD CONSTRAINT ck_nfse_config_prefeitura_cadastro
    CHECK (prefeitura_cadastro_confirmado IS NULL OR prefeitura_cadastro_confirmado IN ('sim', 'nao', 'nao_sei'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE nfse_config ADD CONSTRAINT ck_nfse_config_teste_next_dps_number
    CHECK (teste_next_dps_number >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN nfse_config.aliquota_iss_retencao_sn IS
  'Alíquota efetiva do ISSQN no Simples (pAliq da DPS quando o tomador retém), 1,80 a 5,00. Só para ME/EPP com cliente_retem_iss. Nunca preenchida pela Aura.';
COMMENT ON COLUMN nfse_config.cliente_retem_iss IS
  'Resposta da lojista: algum cliente faz a Retenção do ISSQN? Nulo = ainda não respondeu.';
COMMENT ON COLUMN nfse_config.ultimo_teste_status IS
  'Resultado da última nota de teste em produção restrita: ok | rejeitado | erro.';
COMMENT ON COLUMN nfse_config.ultimo_teste_codigo IS
  'Código do aviso do Sistema Nacional na última nota de teste (ex.: E0084, E0116, E0120).';
COMMENT ON COLUMN nfse_config.ultimo_teste_nfse_id IS
  'nfse.id da última nota de teste (source_type = teste, ambiente producao_restrita).';
COMMENT ON COLUMN nfse_config.prefeitura_cadastro_confirmado IS
  'Resposta da lojista: a prefeitura já incluiu a empresa no CNC da NFS-e? sim | nao | nao_sei.';
COMMENT ON COLUMN nfse_config.serie_confirmada_em IS
  'Quando a lojista confirmou a Série da DPS e o próximo Número da DPS na tela de configuração.';
COMMENT ON COLUMN nfse_config.teste_next_dps_number IS
  'Próximo Número da DPS da série de teste (49999) em produção restrita. Separado de next_dps_number: o teste nunca gasta a numeração da loja.';
