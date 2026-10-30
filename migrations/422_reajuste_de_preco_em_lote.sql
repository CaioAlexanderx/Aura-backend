-- ============================================================
-- 422 — Reajuste de preco em lote (p-51, 30/10/2026)
--
-- Estoque > Selecionar > Ajustar preco grava aqui cada lote aplicado e,
-- por item, o preco antes e depois. Nao havia historico de preco nenhum
-- (o trigger de products sobe updated_at em qualquer update, inclusive
-- baixa de estoque), entao o "desfazer" (PR 2) so pode comparar o preco
-- atual com o "depois" gravado aqui.
--
--   product_price_adjustments        um lote: empresa, quem, quando, modo e
--                                    parametros, contagens e o desfazer.
--   product_price_adjustment_items   um item por linha que mudou: produto
--                                    (variant_id quando a variante tem
--                                    preco proprio), preco e preco no
--                                    cartao antes/depois.
--
-- So guarda o que o lote mudou; nunca toca estoque, custo nem codigo.
-- As colunas undone_* e undo_status sao usadas pelo desfazer (PR 2) e ja
-- nascem aqui para a feature ter uma migration so.
--
-- FK de produto/variante com ON DELETE CASCADE: o historico do reajuste
-- nunca pode segurar a exclusao de um produto.
--
-- Nenhuma linha existente muda. Idempotente.
-- Caminho de volta (depois de reverter os PRs):
--   DROP TABLE IF EXISTS product_price_adjustment_items;
--   DROP TABLE IF EXISTS product_price_adjustments;
-- ============================================================

CREATE TABLE IF NOT EXISTS product_price_adjustments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
  mode                TEXT NOT NULL CHECK (mode IN ('percent', 'fixed', 'markup', 'margin')),
  direction           TEXT CHECK (direction IN ('up', 'down')),
  value               NUMERIC(12,4) NOT NULL,
  rounding            TEXT NOT NULL DEFAULT 'none' CHECK (rounding IN ('none', '90', '99', '00')),
  allow_below_cost    BOOLEAN NOT NULL DEFAULT false,
  products_count      INTEGER NOT NULL DEFAULT 0,
  items_count         INTEGER NOT NULL DEFAULT 0,
  skipped_count       INTEGER NOT NULL DEFAULT 0,
  below_cost_count    INTEGER NOT NULL DEFAULT 0,
  group_shared_count  INTEGER NOT NULL DEFAULT 0,
  summary             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  undone_at           TIMESTAMPTZ,
  undone_by           UUID REFERENCES users(id) ON DELETE SET NULL,
  undo_restored_count INTEGER,
  undo_changed_count  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_price_adjustments_company
  ON product_price_adjustments (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS product_price_adjustment_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_id      UUID NOT NULL REFERENCES product_price_adjustments(id) ON DELETE CASCADE,
  product_id         UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id         UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  owner_company_id   UUID,
  group_shared       BOOLEAN NOT NULL DEFAULT false,
  name               TEXT,
  variant_label      TEXT,
  cost_price         NUMERIC(10,2),
  price_before       NUMERIC(10,2) NOT NULL,
  price_after        NUMERIC(10,2) NOT NULL,
  card_price_before  NUMERIC(10,2),
  card_price_after   NUMERIC(10,2),
  below_cost         BOOLEAN NOT NULL DEFAULT false,
  undo_status        TEXT CHECK (undo_status IN ('restored', 'changed_after'))
);

CREATE INDEX IF NOT EXISTS idx_price_adjustment_items_adjustment
  ON product_price_adjustment_items (adjustment_id);
CREATE INDEX IF NOT EXISTS idx_price_adjustment_items_product
  ON product_price_adjustment_items (product_id);

COMMENT ON TABLE product_price_adjustments IS
  'p-51: lote de reajuste de preco (Estoque > Ajustar preco). Desfazer por 7 dias.';
COMMENT ON TABLE product_price_adjustment_items IS
  'p-51: preco e preco no cartao antes/depois de cada linha que o lote mudou.';
