-- 144_credit_manual_source.sql
-- Adiciona campo source para distinguir lançamentos manuais de vendas no crediário
-- Manual = lançamento criado direto na tela Crediário (sem venda vinculada)
-- Sale = debit criado pelo PDV via createCreditSale

ALTER TABLE customer_credit_transactions
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'sale';
