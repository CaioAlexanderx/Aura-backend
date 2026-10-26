-- ============================================================
-- AURA. — Migration 413: contas pendentes (tq-113, 26/10/2026)
--
-- Decisão do Caio (26/10, opção B): a conta continua sendo criada na etapa 3
-- do cadastro, antes da confirmação do e-mail. Quem nunca confirma sai das
-- listas, contagens e e-mails (src/utils/contaPendente.js) e, depois de 7
-- dias, a empresa é DESATIVADA pelo job diário (src/services/
-- limpezaPendentes.js) — is_active=false, nunca DELETE. Se a pessoa
-- confirmar o e-mail depois, a empresa volta (routes/verification.js).
--
-- Colunas:
--   companies.desativada_por  quem desativou a empresa. O job grava
--                             'conta_pendente'; a reativação ao confirmar o
--                             e-mail só reabre empresa com esse valor (nunca
--                             uma desativada à mão pela equipe ou por outro
--                             motivo). NULL = nunca desativada por regra.
--   companies.desativada_em   quando.
--   signup_leads.motivo       por que o lead voltou a ser lead. O job grava
--                             'nao_confirmou_email' (cria o lead a partir do
--                             usuário quando ele não existe).
--
-- O audit_log continua sendo o histórico (uma linha por empresa desativada
-- ou reativada); a coluna é o que a reativação consulta, para não depender
-- de procurar texto no histórico.
--
-- Idempotente. Nenhuma linha existente muda: as colunas nascem NULL.
-- Caminho de volta: as colunas podem ficar (ninguém mais as lê); para
-- remover, DROP COLUMN IF EXISTS das três.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS desativada_por TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS desativada_em TIMESTAMPTZ;

COMMENT ON COLUMN companies.desativada_por IS
  'Quem desativou a empresa por regra (tq-113): conta_pendente = dono não confirmou o e-mail em 7 dias. A confirmação reativa só estas.';
COMMENT ON COLUMN companies.desativada_em IS
  'Quando a empresa foi desativada por regra (ver desativada_por).';

CREATE INDEX IF NOT EXISTS idx_companies_desativada_por
  ON companies (owner_id)
  WHERE desativada_por IS NOT NULL;

DO $$ BEGIN
  IF to_regclass('public.signup_leads') IS NOT NULL THEN
    ALTER TABLE signup_leads ADD COLUMN IF NOT EXISTS motivo TEXT;
    COMMENT ON COLUMN signup_leads.motivo IS
      'Por que o lead voltou a ser lead (tq-113): nao_confirmou_email = a conta foi desativada porque o dono não confirmou o e-mail.';
  END IF;
END $$;
