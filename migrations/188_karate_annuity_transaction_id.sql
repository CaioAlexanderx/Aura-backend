-- ============================================================
-- 188_karate_annuity_transaction_id.sql
-- Schema-drift fix (24/06/2026).
--
-- karateAnnuities.js referencia karate_dojo_annuity_history.transaction_id em:
--   - GET  /financial/annuities/dojos  (SELECT h.transaction_id)  -> dava 500
--   - POST .../charge                  (INSERT ... transaction_id)
--   - POST .../pix                     (lê annuity.transaction_id p/ o intent)
--   - POST .../confirm                 (reconcilia transactions via o intent)
-- ...mas a coluna nunca foi criada na migration original da tabela. Sem ela, o
-- GET /annuities/dojos retornava 500 ("column h.transaction_id does not exist").
--
-- Idempotente. Já aplicada em produção via ALTER ... ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE karate_dojo_annuity_history
  ADD COLUMN IF NOT EXISTS transaction_id uuid;
