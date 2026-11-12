-- ============================================================
-- 448 — Preencher custos em massa (conferência de estoque, 12/11/2026)
--
-- Conferência de estoque > "Preencher custos": o lojista digita o custo dos
-- produtos que estão sem custo (ou usa o atalho que sugere pelo preço de
-- venda) e grava tudo de uma vez. Cada gravação vira um lote aqui, com o
-- custo antes e depois de cada produto, para o "desfazer" (7 dias).
--
--   product_cost_fills        um lote: loja, quem, quando, atalho usado
--                             (markup ou margem e o %), contagens e o
--                             desfazer.
--   product_cost_fill_items   um item por produto gravado: custo antes
--                             (aceita nulo: o produto estava sem custo),
--                             custo depois, custo médio antes, de onde veio
--                             o número (digitado, sugerido, mesmo) e o que o
--                             desfazer fez com ele.
--
-- Só grava products.cost_price. O custo médio (weighted_avg_cost) não muda;
-- fica guardado aqui só para o desfazer saber se uma entrada de mercadoria
-- mexeu no produto depois (regra "mudou depois").
--
-- stock_count_item_ids: itens de conferência em rascunho da loja que estavam
-- sem custo no bipe e passaram a usar o custo novo. O desfazer volta só
-- esses (e só se o custo ainda é o gravado).
--
-- FK de produto com ON DELETE CASCADE: o histórico nunca segura a exclusão
-- de um produto.
--
-- Só aditiva: nenhuma tabela ou linha existente muda. Idempotente.
-- Caminho de volta (depois de reverter o PR):
--   DROP TABLE IF EXISTS product_cost_fill_items;
--   DROP TABLE IF EXISTS product_cost_fills;
-- ============================================================

CREATE TABLE IF NOT EXISTS product_cost_fills (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  shortcut_mode        TEXT CHECK (shortcut_mode IN ('markup', 'margem')),
  shortcut_percent     NUMERIC(8,2),
  stock_count_id       UUID REFERENCES stock_counts(id) ON DELETE SET NULL,
  products_count       INTEGER NOT NULL DEFAULT 0,
  typed_count          INTEGER NOT NULL DEFAULT 0,
  suggested_count      INTEGER NOT NULL DEFAULT 0,
  same_count           INTEGER NOT NULL DEFAULT 0,
  group_shared_count   INTEGER NOT NULL DEFAULT 0,
  changed_midway_count INTEGER NOT NULL DEFAULT 0,
  count_items_updated  INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undo_deadline        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  undone_at            TIMESTAMPTZ,
  undone_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  undo_restored_count  INTEGER,
  undo_changed_count   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_cost_fills_company
  ON product_cost_fills (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS product_cost_fill_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fill_id               UUID NOT NULL REFERENCES product_cost_fills(id) ON DELETE CASCADE,
  product_id            UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name                  TEXT,
  origin                TEXT NOT NULL CHECK (origin IN ('digitado', 'sugerido', 'mesmo')),
  group_shared          BOOLEAN NOT NULL DEFAULT false,
  price                 NUMERIC(10,2),
  cost_before           NUMERIC(10,2),
  cost_after            NUMERIC(10,2) NOT NULL,
  weighted_avg_before   NUMERIC(10,4),
  stock_count_item_ids  UUID[] NOT NULL DEFAULT '{}',
  undo_status           TEXT CHECK (undo_status IN ('restored', 'changed_after'))
);

CREATE INDEX IF NOT EXISTS idx_cost_fill_items_fill
  ON product_cost_fill_items (fill_id);
CREATE INDEX IF NOT EXISTS idx_cost_fill_items_product
  ON product_cost_fill_items (product_id);

COMMENT ON TABLE product_cost_fills IS
  '448: lote de "preencher custos em massa" (conferencia de estoque). Desfazer por 7 dias.';
COMMENT ON TABLE product_cost_fill_items IS
  '448: custo antes (nulo = sem custo) e depois de cada produto do lote; origem digitado/sugerido/mesmo.';
