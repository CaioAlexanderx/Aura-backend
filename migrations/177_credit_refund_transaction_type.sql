-- 177_credit_refund_transaction_type.sql
-- B4 (devolucao de crediario): permite type='refund' em customer_credit_transactions.
-- A view customer_credit_balances ja trata qualquer type != 'debit' como -amount,
-- entao 'refund' reduz o saldo (excedente => saldo negativo = credito a favor).
-- Idempotente: DROP IF EXISTS + ADD. APLICADA no Supabase em 11/06/2026.
ALTER TABLE customer_credit_transactions
  DROP CONSTRAINT IF EXISTS customer_credit_transactions_type_check;
ALTER TABLE customer_credit_transactions
  ADD  CONSTRAINT customer_credit_transactions_type_check
  CHECK (type = ANY (ARRAY['debit'::text, 'payment'::text, 'refund'::text]));
