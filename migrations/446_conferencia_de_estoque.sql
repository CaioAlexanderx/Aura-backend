-- ============================================================
-- 446 — Conferencia de estoque (card p-108, 11/11/2026)
--
-- O lojista conta o que tem na prateleira, a Aura mostra onde o sistema
-- discorda e ele ajusta. Por loja (company); produto de grupo
-- compartilhado (is_group_shared) so entra na conferencia da loja dona.
--   /companies/:id/estoque/conferencias   (src/routes/estoqueConferencias.js)
--
--   stock_counts        uma conferencia: escopo, as cegas, motivo, numero
--                       sequencial por loja e o ciclo rascunho -> aplicada
--                       -> desfeita (ou descartada).
--   stock_count_items   um item por produto/variante: o contado e o SNAPSHOT
--                       do primeiro bipe (estoque_no_bipe, custo_no_bipe).
--                       Bipes seguintes so mudam o contado.
--
-- Regra do ajuste: diferenca = contado - estoque_no_bipe, aplicada sobre o
-- estoque ATUAL (com piso 0); a diferenca efetiva fica em
-- diferenca_aplicada. Desfazer aplica o inverso dela (diferenca_desfeita
-- guarda o efetivo da volta). Os lancamentos ficam em stock_movements
-- (type 'adjustment', reference_type 'stock_count' / 'stock_count_undo');
-- esta migration nao mexe em stock_movements.
--
-- stock_transfers.stock_count_id liga a transferencia feita a partir da
-- conferencia (migration 444).
--
-- Nenhuma linha existente muda. Sem backfill. Idempotente.
-- Caminho de volta (depois de reverter o PR):
--   ALTER TABLE stock_transfers DROP COLUMN IF EXISTS stock_count_id;
--   DROP TABLE IF EXISTS stock_count_items;
--   DROP TABLE IF EXISTS stock_counts;
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_counts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  numero              INTEGER NOT NULL,
  escopo              JSONB NOT NULL,
  as_cegas            BOOLEAN NOT NULL DEFAULT true,
  motivo              TEXT,
  status              TEXT NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho', 'aplicada', 'desfeita', 'descartada')),
  criada_por          UUID REFERENCES users(id) ON DELETE SET NULL,
  aplicada_por        UUID REFERENCES users(id) ON DELETE SET NULL,
  aplicada_em         TIMESTAMPTZ,
  desfeita_por        UUID REFERENCES users(id) ON DELETE SET NULL,
  desfeita_em         TIMESTAMPTZ,
  zerou_nao_contados  BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_counts_company_numero
  ON stock_counts (company_id, numero);
CREATE INDEX IF NOT EXISTS idx_stock_counts_company_created
  ON stock_counts (company_id, created_at DESC);

-- FK de produto/variante com ON DELETE CASCADE: produto excluido leva a
-- linha da conferencia junto (como stock_movements). Sem SET NULL na
-- variante: duas linhas virariam "sem variante" e colidiriam no unico.
CREATE TABLE IF NOT EXISTS stock_count_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_count_id      UUID NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id          UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id          UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  contado             NUMERIC(14,3) NOT NULL DEFAULT 0,
  estoque_no_bipe     NUMERIC(14,3) NOT NULL,
  custo_no_bipe       NUMERIC(14,4),
  contado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  diferenca_aplicada  NUMERIC(14,3),
  diferenca_desfeita  NUMERIC(14,3),
  nao_contado         BOOLEAN NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_count_items_linha
  ON stock_count_items (stock_count_id, product_id, (COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)));
CREATE INDEX IF NOT EXISTS idx_stock_count_items_count
  ON stock_count_items (stock_count_id, atualizado_em DESC);
CREATE INDEX IF NOT EXISTS idx_stock_count_items_product
  ON stock_count_items (product_id);

ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS stock_count_id UUID REFERENCES stock_counts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_stock_transfers_stock_count
  ON stock_transfers (stock_count_id) WHERE stock_count_id IS NOT NULL;

COMMENT ON TABLE stock_counts IS
  '446: conferencia de estoque por loja. numero sequencial por loja; rascunho -> aplicada -> desfeita (ou descartada).';
COMMENT ON TABLE stock_count_items IS
  '446: item contado. estoque_no_bipe/custo_no_bipe = snapshot do primeiro bipe; ajuste = contado - estoque_no_bipe sobre o estoque atual.';
COMMENT ON COLUMN stock_transfers.stock_count_id IS
  '446: conferencia de onde a transferencia saiu (opcional).';
