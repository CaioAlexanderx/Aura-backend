-- ============================================================
-- Migration 042: Backfill income transactions para vendas PDV
-- ============================================================
-- Algumas vendas PDV nao geraram o registro correspondente na tabela
-- transactions (race condition / falha silenciosa). Isso criava divergencia
-- entre o total de receitas (tabela sales) e o de entradas (transactions).
--
-- Esta migration e IDEMPOTENTE via ON CONFLICT (idempotency_key) DO NOTHING.
-- Pode ser executada quantas vezes for necessario sem efeito colateral.
-- ============================================================

-- Garante que a coluna idempotency_key tem constraint UNIQUE (ja existe, mas
-- caso nao exista cria sem erro).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_idempotency_key_unique'
      AND conrelid = 'transactions'::regclass
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_idempotency_key_unique UNIQUE (idempotency_key);
  END IF;
EXCEPTION WHEN others THEN
  -- Se a constraint ja existe com outro nome, ignora
  NULL;
END$$;

-- Insere transactions faltantes para vendas PDV sem lancamento correspondente
INSERT INTO transactions (
  company_id,
  type,
  amount,
  description,
  category,
  status,
  paid_at,
  due_date,
  payment_method,
  employee_id,
  employee_name,
  idempotency_key,
  created_at,
  updated_at
)
SELECT
  s.company_id,
  'income'                                         AS type,
  s.total_amount                                   AS amount,
  'Venda PDV (backfill)'                           AS description,
  'Vendas'                                         AS category,
  'confirmed'                                      AS status,
  COALESCE(s.updated_at, s.created_at)             AS paid_at,
  (s.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS due_date,
  s.payment_method                                 AS payment_method,
  s.seller_id                                      AS employee_id,
  s.seller_name                                    AS employee_name,
  'pdv-sale-' || s.id                              AS idempotency_key,
  s.created_at                                     AS created_at,
  NOW()                                            AS updated_at
FROM sales s
WHERE
  -- So vendas nao canceladas
  COALESCE(s.status, 'completed') != 'cancelled'
  -- Que ainda nao tem lancamento correspondente
  AND NOT EXISTS (
    SELECT 1
    FROM transactions t
    WHERE t.idempotency_key = 'pdv-sale-' || s.id
      AND t.company_id = s.company_id
  )
ON CONFLICT (idempotency_key) DO NOTHING;
