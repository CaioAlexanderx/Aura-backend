-- 145_credit_installments_sale_id_nullable.sql
-- sale_id deve aceitar NULL para lançamentos manuais de crediário (sem venda vinculada)
ALTER TABLE credit_installments ALTER COLUMN sale_id DROP NOT NULL;
