-- 362 — Valor original do lançamento (valor do boleto) · 28/09/2026
--
-- Feedback de lojista: boleto pago com atraso sai com juros, e ela quer
-- registrar o VALOR PAGO sem calcular juros nem porcentagem. Na baixa com
-- valor diferente, amount passa a ser o valor pago (o que saiu do caixa, e o
-- que todos os relatórios já somam) e o valor do boleto fica guardado aqui.
-- Desfazer a baixa restaura amount = original_amount e limpa esta coluna.
-- NULL = o valor pago é o próprio valor do lançamento (caso comum).

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_amount NUMERIC(12,2);

DO $$ BEGIN
  ALTER TABLE transactions
    ADD CONSTRAINT transactions_original_amount_positive CHECK (original_amount IS NULL OR original_amount > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
