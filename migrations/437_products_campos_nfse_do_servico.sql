-- ============================================================
-- 437 — Campos de NFS-e no cadastro do servico (10/11/2026)
--
-- Contexto: o emissor proprio de NFS-e pelo Emissor Nacional (migration
-- 429, src/services/nfseNacional) so conhece o padrao da EMPRESA
-- (nfse_config.ctribnac_padrao / cnbs_padrao / default_iss_rate). Loja que
-- presta mais de um servico (instalacao e manutencao, corte e coloracao)
-- precisa de codigo e aliquota POR SERVICO. Servico no estoque e
-- products.unit = 'srv'; ate aqui products nao tinha nenhuma coluna fiscal
-- de servico (so as de mercadoria: ncm, cest, origem, icms_st_paid).
--
-- Precedencia na emissao (POST /companies/:id/nfse com product_id):
--   valor explicito na nota -> valor do item (estas colunas) -> padrao da
--   empresa (nfse_config). Descricao: nota -> nfse_descricao -> nome.
--
-- DECISOES:
-- - Tudo nulavel, sem default e sem backfill: NULL = segue o padrao da
--   empresa, que e exatamente o comportamento de hoje. Nenhum dado
--   existente muda (contrato de zero impacto, mesmo da 350/351).
-- - Codigos guardados so com digitos (a rota tira pontuacao e valida):
--   cTribNac 6, NBS 9, cTribMun 3, CST 3, cClassTrib 6, cIndOp 6.
-- - Aliquota do ISS em % (0 a 5, LC 116/2003 art. 8, II), mesmo tipo de
--   nfse_config.default_iss_rate (numeric(5,2), migration 058).
-- - cTribMun e IBS/CBS (CST, cClassTrib, cIndOp — reforma tributaria, LC
--   214/2025) ja nascem aqui, mas o leiaute da DPS ainda NAO os usa: entram
--   no XML num PR proprio. Gravar antes evita a lojista digitar duas vezes.
-- - Validacao fica na rota (src/services/camposNfseDoItem.js).
--
-- So ADITIVA e idempotente (ADD COLUMN IF NOT EXISTS). Sem reescrita de
-- tabela, sem indice.
--
-- Caminho de volta (e reverter o PR: o codigo le e grava as colunas, com
-- degrau 42703 para base sem elas):
--   ALTER TABLE products
--     DROP COLUMN IF EXISTS nfse_ctribnac,
--     DROP COLUMN IF EXISTS nfse_cnbs,
--     DROP COLUMN IF EXISTS nfse_ctribmun,
--     DROP COLUMN IF EXISTS nfse_aliquota_iss,
--     DROP COLUMN IF EXISTS nfse_descricao,
--     DROP COLUMN IF EXISTS ibscbs_cst,
--     DROP COLUMN IF EXISTS ibscbs_cclasstrib,
--     DROP COLUMN IF EXISTS ibscbs_cindop;
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS nfse_ctribnac     varchar(6),
  ADD COLUMN IF NOT EXISTS nfse_cnbs         varchar(9),
  ADD COLUMN IF NOT EXISTS nfse_ctribmun     varchar(3),
  ADD COLUMN IF NOT EXISTS nfse_aliquota_iss numeric(5,2),
  ADD COLUMN IF NOT EXISTS nfse_descricao    text,
  ADD COLUMN IF NOT EXISTS ibscbs_cst        varchar(3),
  ADD COLUMN IF NOT EXISTS ibscbs_cclasstrib varchar(6),
  ADD COLUMN IF NOT EXISTS ibscbs_cindop     varchar(6);

COMMENT ON COLUMN products.nfse_ctribnac IS
  'NFS-e: codigo de tributacao nacional (cTribNac, 6 digitos, item da LC 116 + subitem). NULL = nfse_config.ctribnac_padrao. Migration 437.';
COMMENT ON COLUMN products.nfse_cnbs IS
  'NFS-e: codigo NBS do servico (cNBS, 9 digitos). NULL = nfse_config.cnbs_padrao. Migration 437.';
COMMENT ON COLUMN products.nfse_ctribmun IS
  'NFS-e: codigo de tributacao municipal (cTribMun, 3 digitos). Ainda nao vai no XML da DPS. Migration 437.';
COMMENT ON COLUMN products.nfse_aliquota_iss IS
  'NFS-e: aliquota do ISS em % (0 a 5). NULL = nfse_config.default_iss_rate. Migration 437.';
COMMENT ON COLUMN products.nfse_descricao IS
  'NFS-e: descricao do servico na nota (ate 2000 caracteres). NULL = nome do item. Migration 437.';
COMMENT ON COLUMN products.ibscbs_cst IS
  'IBS/CBS (LC 214/2025): CST, 3 digitos. Ainda nao vai no XML da DPS. Migration 437.';
COMMENT ON COLUMN products.ibscbs_cclasstrib IS
  'IBS/CBS (LC 214/2025): classificacao tributaria (cClassTrib), 6 digitos. Ainda nao vai no XML da DPS. Migration 437.';
COMMENT ON COLUMN products.ibscbs_cindop IS
  'IBS/CBS (LC 214/2025): indicador da operacao (cIndOp), 6 digitos. Ainda nao vai no XML da DPS. Migration 437.';
