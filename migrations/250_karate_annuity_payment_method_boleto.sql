-- ============================================================
-- AURA KARATÊ — Migration 250: 'boleto' como forma de pagamento
-- de anuidade
-- ------------------------------------------------------------
-- Contexto (decisão do Caio, 23/07/2026): a planilha de anuidades 2026
-- usa Boleto em 3 dojôs — 'boleto' entra na lista oficial de formas de
-- pagamento de anuidade, junto de pix/dinheiro/transferencia/
-- credito_cbkt/credito_exame/outro (VALID_PAYMENT_METHODS em
-- src/services/karateAnnuityService.js).
--
-- karate_annuity_installments_payment_method_check (migration 222,
-- expandida na 247 para credito_cbkt/credito_exame) precisa ganhar
-- 'boleto' — mesmo padrão da 247: Postgres não tem ALTER CHECK, então
-- DROP + ADD.
--
-- karate_annuity_payments (o ledger, migration 247) NÃO tem CHECK em
-- payment_method (coluna text livre, confirmado no catálogo em prod via
-- Supabase MCP em 23/07/2026) — já aceita 'boleto' sem mudança nenhuma.
--
-- Esta migration NÃO é aplicada em produção neste PR (padrão das
-- 241-249 — aplicar via Supabase MCP depois do merge). Idempotente de
-- ponta a ponta.
-- ============================================================

ALTER TABLE karate_annuity_installments
  DROP CONSTRAINT IF EXISTS karate_annuity_installments_payment_method_check;

ALTER TABLE karate_annuity_installments
  ADD CONSTRAINT karate_annuity_installments_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN
    ('pix', 'dinheiro', 'transferencia', 'credito_cbkt', 'credito_exame', 'boleto', 'outro'));

-- ============================================================
-- FIM DA MIGRATION 250
-- ============================================================
