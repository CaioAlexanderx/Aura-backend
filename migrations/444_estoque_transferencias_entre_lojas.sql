-- ============================================================
-- 444 — Transferencia de estoque entre lojas do grupo (10/11/2026)
--
-- Loja com mais de um CNPJ no grupo (mesmo billing_owner_company_id) manda
-- pecas de uma loja para a outra, cada uma com o seu estoque.
--   POST /companies/:id/estoque/transferencias   (:id = origem)
--   GET  /companies/:id/estoque/transferencias   (origem ou destino)
--
--   stock_transfers        uma transferencia: grupo, numero sequencial por
--                          grupo, origem, destino, quem e quando.
--   stock_transfer_items   um item por produto/variante: o de origem, o de
--                          destino (achado ou criado na hora) e a
--                          quantidade. E tambem o VINCULO origem -> destino:
--                          a proxima transferencia do mesmo item acha o
--                          produto do destino por aqui antes de olhar
--                          codigo de barras e SKU.
--
-- As baixas e entradas ficam em stock_movements (tipo 'out' na origem e
-- 'in' no destino, reference_type = 'stock_transfer', reference_id = id
-- da transferencia). Esta migration nao mexe em stock_movements.
--
-- FK de produto/variante com ON DELETE SET NULL: o historico nunca segura
-- a exclusao de um produto (nome e variante ficam no snapshot).
--
-- Nenhuma linha existente muda. Sem backfill. Idempotente.
-- Caminho de volta (depois de reverter o PR):
--   DROP TABLE IF EXISTS stock_transfer_items;
--   DROP TABLE IF EXISTS stock_transfers;
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_transfers (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grupo_company_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  numero              INTEGER NOT NULL,
  origem_company_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  destino_company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  criada_por          UUID REFERENCES users(id) ON DELETE SET NULL,
  observacao          TEXT,
  itens_count         INTEGER NOT NULL DEFAULT 0,
  quantidade_total    NUMERIC(14,3) NOT NULL DEFAULT 0,
  criada_em           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT stock_transfers_lojas_diferentes CHECK (origem_company_id <> destino_company_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_transfers_grupo_numero
  ON stock_transfers (grupo_company_id, numero);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_origem
  ON stock_transfers (origem_company_id, criada_em DESC);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_destino
  ON stock_transfers (destino_company_id, criada_em DESC);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id         UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id          UUID REFERENCES products(id) ON DELETE SET NULL,
  variant_id          UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  destino_product_id  UUID REFERENCES products(id) ON DELETE SET NULL,
  destino_variant_id  UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  quantidade          NUMERIC(14,3) NOT NULL CHECK (quantidade > 0),
  criado_no_destino   BOOLEAN NOT NULL DEFAULT false,
  nome                TEXT,
  variante            TEXT
);

CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer
  ON stock_transfer_items (transfer_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_product
  ON stock_transfer_items (product_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_destino_product
  ON stock_transfer_items (destino_product_id);

COMMENT ON TABLE stock_transfers IS
  '444: transferencia de estoque entre lojas do mesmo grupo. numero sequencial por grupo.';
COMMENT ON TABLE stock_transfer_items IS
  '444: item transferido (origem -> destino). Serve de vinculo para a proxima transferencia.';
