-- 151_credit_customer_terms.sql
-- F2: termos personalizados por cliente no crediario
-- Todos os campos NULL = usa config da loja (comportamento atual preservado)

ALTER TABLE customer_credit_profiles
  ADD COLUMN IF NOT EXISTS term_interest_rate      numeric,
  ADD COLUMN IF NOT EXISTS term_max_installments   int,
  ADD COLUMN IF NOT EXISTS term_period_unit        text,
  ADD COLUMN IF NOT EXISTS term_period_count       int,
  ADD COLUMN IF NOT EXISTS term_due_day            int,
  ADD COLUMN IF NOT EXISTS term_late_fee_rate      numeric,
  ADD COLUMN IF NOT EXISTS term_late_interest_daily numeric;
