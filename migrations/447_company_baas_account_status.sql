-- ============================================================
-- AURA. — Migration 447: Recebe na Aura — situação da subconta em 4 blocos (RA-06)
-- company_baas_accounts.account_status / account_status_at
-- ------------------------------------------------------------
-- 12/11/2026. A Asaas devolve a situação cadastral da subconta em quatro
-- blocos (GET /v3/myAccount/status/ com a chave da subconta, e o mesmo
-- objeto `accountStatus` nos eventos ACCOUNT_STATUS_*):
--   commercialInfo   dados comerciais
--   documentation    documentos
--   bankAccountInfo  dados bancários
--   general          aprovação geral
-- Cada um vale PENDING | AWAITING_APPROVAL | APPROVED | REJECTED.
--
-- account_status guarda o último retrato dos quatro (jsonb, só esses
-- campos); account_status_at, de quando é o retrato (a hora da leitura na
-- Asaas ou o dateCreated do evento). O RA-07 grava pelos avisos; o RA-06 lê
-- e permite atualizar lendo da Asaas. O status resumido (coluna status)
-- continua o mesmo da 436.
--
-- Atrás da flag RECEBE_NA_AURA_ENABLED. Sem backfill. Idempotente.
-- ============================================================

ALTER TABLE company_baas_accounts
  ADD COLUMN IF NOT EXISTS account_status    jsonb,
  ADD COLUMN IF NOT EXISTS account_status_at timestamptz;

COMMENT ON COLUMN company_baas_accounts.account_status IS
  'RA-06: último retrato da situação cadastral da subconta na Asaas, em 4 blocos: {commercialInfo, documentation, bankAccountInfo, general}, cada um PENDING | AWAITING_APPROVAL | APPROVED | REJECTED. Sem outros campos.';
COMMENT ON COLUMN company_baas_accounts.account_status_at IS
  'RA-06: de quando é o retrato em account_status (leitura na Asaas ou dateCreated do evento). Retrato mais velho não sobrescreve um mais novo.';
