-- 178_fix_cct_idempotency_full_unique_index.sql
-- ============================================================================
-- BUG: confirmar recebimento de pagamento no crediario (valor livre / B3)
--      retornava 500 com:
--      42P10 "there is no unique or exclusion constraint matching the
--             ON CONFLICT specification"
--
-- CAUSA: applyPayment (src/services/credit/ledger.js) faz, no caminho
--        idempotente (Idempotency-Key enviado pelo B3):
--          INSERT INTO customer_credit_transactions (...)
--          ON CONFLICT (idempotency_key) DO NOTHING
--        SEM predicado -- exatamente como a tabela `transactions`, que tem um
--        indice unico CHEIO e por isso funciona. Porem o indice de
--        customer_credit_transactions era UNIQUE PARCIAL:
--          CREATE UNIQUE INDEX idx_cct_idempotency_key
--            ON customer_credit_transactions (idempotency_key)
--            WHERE idempotency_key IS NOT NULL;
--        A inferencia de arbiter do `ON CONFLICT (col)` sem predicado NAO casa
--        com indice parcial -> 42P10. So o B3 quebra porque e o unico fluxo de
--        pagamento que envia Idempotency-Key.
--
-- FIX: troca o indice parcial por um indice unico CHEIO (igual a transactions).
--      NULLS DISTINCT (default) preserva multiplos NULL; nao ha duplicata de
--      non-null (o indice parcial ja garantia unicidade desse subconjunto).
--      Idempotente. Ja aplicado em producao (Supabase) em 13/06/2026.
-- ============================================================================

DROP INDEX IF EXISTS idx_cct_idempotency_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cct_idempotency_key
  ON public.customer_credit_transactions (idempotency_key);
