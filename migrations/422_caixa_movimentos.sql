-- ============================================================
-- 422 — Movimentações do caixa aberto: sangria e suprimento (30/10/2026,
-- pedido do Caio: "habilitar a retirada de valores no caixa, quando
-- estiver aberto").
--
--   caixa_movimentos: uma linha por retirada (sangria: dinheiro que SAI da
--       gaveta — depósito no banco, pagar o motoboy, troco para outro
--       caixa) ou reforço (suprimento: dinheiro que ENTRA sem venda, como
--       troco a mais no meio do dia). Sempre presa a uma sessão aberta.
--       Nenhum dos dois é venda: fica fora de total_geral e só mexe no
--       dinheiro esperado na gaveta.
--   caixa_fechamentos.total_sangrias / total_suprimentos: o snapshot do
--       fechamento passa a guardar os dois totais, para o histórico e o PDF
--       explicarem o dinheiro_esperado (troco + vendas em dinheiro +
--       suprimentos − sangrias).
--
-- Nenhuma linha existente muda (os totais nascem 0). Idempotente.
-- Caminho de volta (depois de reverter o PR):
--   DROP TABLE IF EXISTS caixa_movimentos;
--   ALTER TABLE caixa_fechamentos DROP COLUMN IF EXISTS total_sangrias,
--     DROP COLUMN IF EXISTS total_suprimentos;
-- ============================================================

CREATE TABLE IF NOT EXISTS caixa_movimentos (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID          NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sessao_id   UUID          NOT NULL REFERENCES caixa_sessoes(id) ON DELETE CASCADE,
  tipo        TEXT          NOT NULL CHECK (tipo IN ('sangria', 'suprimento')),
  valor       NUMERIC(12,2) NOT NULL CHECK (valor > 0),
  motivo      TEXT,
  created_by  UUID          REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_sessao
  ON caixa_movimentos (sessao_id, created_at);

CREATE INDEX IF NOT EXISTS idx_caixa_movimentos_company_date
  ON caixa_movimentos (company_id, created_at DESC);

ALTER TABLE caixa_movimentos ENABLE ROW LEVEL SECURITY;

ALTER TABLE caixa_fechamentos
  ADD COLUMN IF NOT EXISTS total_sangrias    NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE caixa_fechamentos
  ADD COLUMN IF NOT EXISTS total_suprimentos NUMERIC(12,2) NOT NULL DEFAULT 0;

COMMENT ON TABLE caixa_movimentos IS
  'Sangrias (saída de dinheiro) e suprimentos (reforço) de uma sessão de caixa aberta. Não são vendas.';
COMMENT ON COLUMN caixa_fechamentos.total_sangrias IS
  'Soma das sangrias da sessão no fechamento. dinheiro_esperado já as desconta.';
COMMENT ON COLUMN caixa_fechamentos.total_suprimentos IS
  'Soma dos suprimentos da sessão no fechamento. dinheiro_esperado já os soma.';
