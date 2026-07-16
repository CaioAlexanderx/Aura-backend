-- ============================================================
-- AURA KARATÊ — Migration 219: Corrige CHECK de status da anuidade de dojô
-- ------------------------------------------------------------
-- Bug: karateAnnuities.js grava status 'pending' (criação) e 'paid'
-- (conciliação) em karate_dojo_annuity_history, mas o CHECK original só
-- permitia ('active','expiring','overdue','defaulting','suspended').
-- Resultado: toda criação de cobrança de dojô falhava (tabela ficava vazia).
--
-- Correção: amplia o CHECK para unir os dois vocabulários (saúde da filiação
-- + ciclo de pagamento), incluindo 'pending' e 'paid'. Idempotente.
-- ============================================================

ALTER TABLE karate_dojo_annuity_history
  DROP CONSTRAINT IF EXISTS karate_dojo_annuity_history_status_check;

ALTER TABLE karate_dojo_annuity_history
  ADD CONSTRAINT karate_dojo_annuity_history_status_check
  CHECK (status = ANY (ARRAY[
    'active'::text, 'expiring'::text, 'overdue'::text,
    'defaulting'::text, 'suspended'::text,
    'pending'::text, 'paid'::text
  ]));

-- ============================================================
-- FIM DA MIGRATION 219
-- ============================================================
