-- ============================================================
-- AURA KARATÊ — Migration 223: Fase F4 — template editável do e-mail de
-- cobrança de anuidade + libera reenvio manual do lock de idempotência
-- da régua.
-- ------------------------------------------------------------
-- Contexto de negócio: e-mail é infraestrutura para o futuro (hoje só
-- 2/549 faixas-pretas e 2/29 dojôs ativos da federação de referência têm
-- e-mail cadastrado — WhatsApp é o canal real). Os dois coexistem; esta
-- migration só adiciona o template editável e não muda nada do
-- comportamento hoje em produção (colunas novas, default NULL → mailer
-- usa o template padrão atual; régua continua opt-in OFF por padrão).
--
-- O que esta migration faz:
--   a) karate_reminder_config ganha subject_template/body_template (texto
--      livre com variáveis {{nome}} {{competencia}} {{valor}}
--      {{vencimento}} {{planos}} {{pix_copia_cola}} — render em
--      src/services/karateReminderTemplate.js). NULL = usa o default
--      hardcoded (nenhuma mudança de comportamento pra quem não
--      configurar nada).
--   b) karate_reminder_log: o índice único de idempotência da migration
--      174 (uq_karate_reminder_once, sobre annuity_id+rule_code+channel
--      WHERE status='sent') passa a EXCLUIR rule_code='manual'. Reenvio
--      manual (POST .../send-email e .../send-email-batch, Fase F4) usa
--      sempre rule_code='manual' e precisa poder ser disparado quantas
--      vezes o operador quiser pro MESMO annuity_id — sem isso, o
--      segundo reenvio manual falharia com 23505 (unique violation) ao
--      tentar logar, silenciosamente perdendo a trilha do reenvio. A
--      régua automática (rule_code=due_minus_7/due_minus_1/overdue_3/...)
--      continua com o lock de idempotência de sempre — só 'manual' é
--      isento.
--
-- Idempotente de ponta a ponta (IF NOT EXISTS / DROP INDEX IF EXISTS +
-- CREATE UNIQUE INDEX IF NOT EXISTS). Sem views tocadas nesta migration —
-- não se aplica aqui a lição de DROP VIEW+CREATE VIEW (42P16) das
-- migrations anteriores.
-- ============================================================

-- (a) Template editável do e-mail de cobrança.
ALTER TABLE karate_reminder_config ADD COLUMN IF NOT EXISTS subject_template text;
ALTER TABLE karate_reminder_config ADD COLUMN IF NOT EXISTS body_template text;

-- (b) Reenvio manual isento do lock de idempotência (rule_code='manual').
DROP INDEX IF EXISTS uq_karate_reminder_once;
CREATE UNIQUE INDEX IF NOT EXISTS uq_karate_reminder_once
  ON karate_reminder_log(annuity_id, rule_code, channel)
  WHERE status = 'sent' AND rule_code <> 'manual';

-- ============================================================
-- FIM DA MIGRATION 223
-- ============================================================
