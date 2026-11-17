-- ============================================================
-- 457 — Cabeçalho da entrada de mercadoria (B1, Estoque Fase 2, 17/11/2026)
--
-- "Chegou mercadoria": uma entrada com vários itens numa ida só
-- (POST /products/stock-receipts, B2a). Esta tabela guarda o cabeçalho:
--   - quem mandou (supplier_id, nulo quando segue sem fornecedor);
--   - a nota: número (invoice_number) e chave de 44 dígitos (nfe_key),
--     para avisar "nota já lançada" sem depender do texto 'NF <n>' que a
--     entrada de um produto grava em stock_movements.notes;
--   - de onde vieram os itens (origin);
--   - a chave contra entrar em dobro (idempotency_key, UNIQUE): o app cria
--     uma ao abrir o wizard; a mesma chave de novo devolve `result` (a
--     resposta guardada) e não soma nada.
-- Os stock_movements da entrada apontam para cá:
--   reference_type = 'entrada', reference_id = stock_receipts.id
-- (o índice idx_stock_movements_reference já cobre a busca).
--
-- company_id é a loja que recebeu (multi-CNPJ: um cabeçalho por CNPJ).
-- Aditiva e idempotente; nada muda para quem não usa a rota nova.
-- ============================================================
CREATE TABLE IF NOT EXISTS stock_receipts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  supplier_id      UUID REFERENCES suppliers(id) ON DELETE SET NULL,
  invoice_number   TEXT,
  nfe_key          TEXT CHECK (nfe_key IS NULL OR nfe_key ~ '^[0-9]{44}$'),
  origin           TEXT NOT NULL DEFAULT 'digitar'
                   CHECK (origin IN ('nota', 'planilha', 'digitar', 'lista')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  result           JSONB,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "Nota já lançada": número + fornecedor na loja.
CREATE INDEX IF NOT EXISTS idx_stock_receipts_nota
  ON stock_receipts (company_id, supplier_id, invoice_number);

-- "Nota já lançada" pela chave da NF-e.
CREATE INDEX IF NOT EXISTS idx_stock_receipts_nfe_key
  ON stock_receipts (company_id, nfe_key)
  WHERE nfe_key IS NOT NULL;
