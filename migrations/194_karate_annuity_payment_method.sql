-- ============================================================
-- 194_karate_annuity_payment_method.sql
-- Baixa manual de anuidade dojô (27/06/2026).
--
-- Adiciona payment_method em karate_dojo_annuity_history para
-- registrar o meio de pagamento na baixa manual (pix / dinheiro /
-- transferencia / outro). Coluna opcional: NULL = não informado
-- (cobranças antigas, PIX via intent, etc.).
--
-- Idempotente. NÃO aplicada automaticamente — executar manualmente
-- após deploy (sem downtime: ADD COLUMN nullable sem default).
-- ============================================================

ALTER TABLE karate_dojo_annuity_history
  ADD COLUMN IF NOT EXISTS payment_method text;
