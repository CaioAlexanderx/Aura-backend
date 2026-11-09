-- ============================================================
-- 431 — Registro das edições de venda (09/11/2026)
--
-- "Editar venda" (PATCH /companies/:id/sales/:sale_id) muda a forma de
-- pagamento, o vendedor(a) e o cliente de uma venda já feita. Cada edição
-- grava aqui o antes, o depois, quem fez, quando e o motivo (opcional).
-- O detalhe da venda mostra "Editada em dd/mm por Fulano" a partir desta
-- tabela.
--
-- Só ADITIVA e idempotente: uma tabela nova e dois índices. Nada existente
-- muda. O backend recusa a edição (503 EDIT_LOG_UNAVAILABLE) enquanto a
-- tabela não existe, para nenhuma edição ficar sem registro.
--
-- Caminho de volta (depois de reverter o PR):
--   DROP TABLE IF EXISTS sale_edits;
-- ============================================================

CREATE TABLE IF NOT EXISTS sale_edits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id         UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  edited_by       UUID NULL,
  edited_by_name  TEXT NULL,
  changes         TEXT[] NOT NULL DEFAULT '{}',
  before          JSONB NOT NULL DEFAULT '{}'::jsonb,
  after           JSONB NOT NULL DEFAULT '{}'::jsonb,
  effects         JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason          TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_edits_sale
  ON sale_edits (sale_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sale_edits_company
  ON sale_edits (company_id, created_at DESC);

ALTER TABLE sale_edits ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE sale_edits IS
  'Uma linha por edição de venda (forma de pagamento, vendedor, cliente): antes, depois, quem, quando e motivo. Migration 431.';
