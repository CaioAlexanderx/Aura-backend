-- ============================================================
-- AURA — Migration 299: teto de parcelas 12 -> 500 + idempotência da renegociação
-- ------------------------------------------------------------
-- Relato Valen (21/08/2026): "lançamento de R$5.400 em 54 parcelas e não
-- consigo — sem erro no Railway".
--
-- Duas coisas nasceram daí:
--
-- 1) TETO DE PARCELAS. `credit_plan_configs.max_installments` nasceu com
--    DEFAULT 12 e NENHUMA das 9 lojas em produção jamais mexeu nesse valor —
--    é default intocado, não política de loja. Só que a Valen vende em 36x e
--    54x na prática (o carnê de hoje tem 54 parcelas), então o 12 barrava o
--    PDV e o parcelamento direto enquanto a renegociação — que não tem teto —
--    passava. O default sobe para 500 e as lojas ainda no 12 acompanham.
--    Quem quiser um teto de verdade continua podendo configurar em
--    PUT /credit/plan-config.
--
-- 2) IDEMPOTÊNCIA DA RENEGOCIAÇÃO. Em 21/08 17:03 a mesma renegociação (54x)
--    foi aplicada DUAS vezes com 33s de intervalo: o servidor aplicou e
--    commitou, a resposta não chegou no app, o lojista viu o toast genérico de
--    erro e clicou de novo. Cada clique cancela o carnê inteiro e recria — o
--    cliente "mae do douglas" acumulou 91 parcelas canceladas. Diferente do
--    lançamento manual (que já deduplica por Idempotency-Key), a renegociação
--    não tinha proteção nenhuma. A tabela abaixo guarda o resultado da
--    aplicação por chave: replay devolve o mesmo payload sem re-executar.
--    A coluna `fingerprint` cobre o clique duplo de um app que ainda não manda
--    o header: pedido idêntico (mesmo carnê, total, nº de parcelas e 1º
--    vencimento) repetido em menos de 60s é replay, não uma nova renegociação.
--
-- Idempotente (IF NOT EXISTS + UPDATE condicionado).
-- ============================================================

-- 1. Teto de parcelas -----------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'credit_plan_configs'
  ) THEN
    ALTER TABLE credit_plan_configs ALTER COLUMN max_installments SET DEFAULT 500;

    -- Só as lojas que continuam no default histórico. Quem já tinha escolhido
    -- outro número (nenhuma, hoje) mantém a escolha.
    UPDATE credit_plan_configs
       SET max_installments = 500,
           updated_at       = NOW()
     WHERE max_installments = 12;
  END IF;
END $$;

-- 2. Recibos de renegociação (idempotência) -------------------------------
CREATE TABLE IF NOT EXISTS credit_reschedule_receipts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID        NOT NULL,
  customer_id     UUID        NOT NULL,
  account_id      UUID,
  idempotency_key TEXT        NOT NULL,
  fingerprint     TEXT,
  result          JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bancos que já criaram a tabela antes da coluna (deploy parcial).
ALTER TABLE credit_reschedule_receipts ADD COLUMN IF NOT EXISTS fingerprint TEXT;

-- A chave é única POR EMPRESA: o replay nunca cruza tenant.
CREATE UNIQUE INDEX IF NOT EXISTS credit_reschedule_receipts_company_key_uk
  ON credit_reschedule_receipts (company_id, idempotency_key);

CREATE INDEX IF NOT EXISTS credit_reschedule_receipts_customer_idx
  ON credit_reschedule_receipts (company_id, customer_id, created_at DESC);

-- Lookup do clique duplo sem header.
CREATE INDEX IF NOT EXISTS credit_reschedule_receipts_fingerprint_idx
  ON credit_reschedule_receipts (company_id, customer_id, fingerprint, created_at DESC);

COMMENT ON TABLE credit_reschedule_receipts IS
  'Recibo por Idempotency-Key de POST /credit/customers/:cid/accounts/:aid/reschedule. Replay devolve result sem re-executar o cancela-e-recria.';
