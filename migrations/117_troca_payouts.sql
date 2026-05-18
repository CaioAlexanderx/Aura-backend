-- ============================================================
-- 117_troca_payouts.sql
-- Troca v2 — registra COMO a loja devolveu dinheiro ao cliente
-- quando netAmount < 0 (saldo a favor do cliente).
--
-- Hoje (v1) o backend cria apenas um sale_payment negativo de
-- -returnedValue; nao ha registro de "estornei R$ 80 em dinheiro
-- do caixa + R$ 60 em PIX". troca_payouts preenche esse gap.
--
-- Metodos aceitos:
--   - dinheiro            → saida fisica do caixa
--   - pix                 → PIX de estorno (operador faz manualmente)
--   - cartao_estorno      → estorno na maquininha
--   - crediario_credito   → ALEM de inserir aqui, grava em
--                           customer_credit_transactions (type='payment',
--                           sem debit correspondente → saldo NEGATIVO
--                           = credito a favor do cliente).
--   - vale                → vale-troca em papel (registro apenas auditavel)
--
-- Caixa: cada linha aqui podera virar tambem um sale_payment
-- negativo no proximo passo (similar ao split de troca atual,
-- mas particionado por metodo). Por enquanto, o caixa continua
-- somando o sale_payments negativo agregado.
--
-- Doc: Aura/AUDITORIA_TROCA_PDV_2026-05-17.docx (Fase 1)
-- ============================================================

CREATE TABLE IF NOT EXISTS troca_payouts (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  troca_sale_id        UUID         NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  company_id           UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id          UUID         NULL REFERENCES customers(id) ON DELETE SET NULL,
  method               TEXT         NOT NULL CHECK (method IN (
    'dinheiro', 'pix', 'cartao_estorno', 'crediario_credito', 'vale'
  )),
  amount               NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  sessao_id            UUID         NULL REFERENCES caixa_sessoes(id) ON DELETE SET NULL,
  -- Linka com customer_credit_transactions quando method=crediario_credito
  -- pra facilitar reverter em cancel de troca.
  credit_transaction_id UUID        NULL REFERENCES customer_credit_transactions(id) ON DELETE SET NULL,
  notes                TEXT         NULL,
  created_by           UUID         NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_troca_payouts_troca_sale
  ON troca_payouts (troca_sale_id);

CREATE INDEX IF NOT EXISTS idx_troca_payouts_company_date
  ON troca_payouts (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_troca_payouts_customer
  ON troca_payouts (customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_troca_payouts_sessao
  ON troca_payouts (sessao_id)
  WHERE sessao_id IS NOT NULL;

COMMENT ON TABLE troca_payouts IS
  'Estornos da troca v2 quando netAmount < 0. Cada linha = uma forma '
  'de devolucao ao cliente. method=crediario_credito tambem grava '
  'em customer_credit_transactions (saldo negativo = credito a favor).';
