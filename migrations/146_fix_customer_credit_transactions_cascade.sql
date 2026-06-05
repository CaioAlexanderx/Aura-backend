-- 146_fix_customer_credit_transactions_cascade.sql
-- Corrige FK customer_credit_transactions_customer_id_fkey de ON DELETE RESTRICT
-- para ON DELETE CASCADE, permitindo deletar clientes que tenham transacoes de
-- crediario. Padrao do projeto: customer_id FKs usam CASCADE (ver migration 136).
-- Idempotente via bloco DO.

DO $$
BEGIN
  -- Dropa a constraint existente (RESTRICT) se ela existir
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'customer_credit_transactions_customer_id_fkey'
      AND table_name = 'customer_credit_transactions'
  ) THEN
    ALTER TABLE customer_credit_transactions
      DROP CONSTRAINT customer_credit_transactions_customer_id_fkey;
  END IF;

  -- Recria com ON DELETE CASCADE
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc
      ON rc.constraint_name = tc.constraint_name
    WHERE tc.table_name = 'customer_credit_transactions'
      AND tc.constraint_name = 'customer_credit_transactions_customer_id_fkey'
      AND rc.delete_rule = 'CASCADE'
  ) THEN
    ALTER TABLE customer_credit_transactions
      ADD CONSTRAINT customer_credit_transactions_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
  END IF;
END $$;
