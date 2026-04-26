-- ============================================================
-- AURA. — Migration 065: Versionar stock_movements (espelho de prod)
--
-- CONTEXTO: a tabela stock_movements existe em PROD (criada via MCP
-- Supabase em data anterior) mas nunca foi commitada como arquivo
-- de migration no repo. Isso quebra o CI do GitHub Actions que roda
-- migrations num banco limpo — ja existem referencias a esta tabela
-- nos services (pdv.js, dentalSupplies.js).
--
-- Mesmo padrao reconhecido na 047_dental_backfill_for_unify
-- ("varias migrations foram aplicadas em producao via MCP Supabase
-- entre 15 e 22/04 sem serem commitadas como arquivo .sql").
--
-- IDEMPOTENTE: CREATE TABLE IF NOT EXISTS, ADD INDEX IF NOT EXISTS.
-- NoOp em PROD. Faz o CI passar. Garante que ambientes novos tenham
-- o schema completo.
--
-- USOS CONFIRMADOS:
--   src/routes/pdv.js (POST /companies/:id/pdv/sale + DELETE /pdv/sale/:id)
--     -> type='out' / 'in', reference_type='sale' / 'sale_cancel'
--   src/routes/dentalSupplies.js (POST /:id/movement)
--     -> type='entrada' / 'saida' / 'ajuste'
--
-- INCONSISTENCIA CONHECIDA: a coluna `type` aceita TANTO {in,out}
-- (nomenclatura PDV) QUANTO {entrada,saida,ajuste} (dental). Mantemos
-- TEXT livre por compatibilidade. Padronizar via ENUM rigido +
-- normalizar dados historicos fica pra V2 (custo: muitas linhas
-- existentes em prod, exige migration de dados).
-- ============================================================

CREATE TABLE IF NOT EXISTS stock_movements (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID            NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  company_id      UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type            TEXT            NOT NULL,
  quantity        NUMERIC(12,3)   NOT NULL,
  reference_id    UUID,
  reference_type  TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_product
  ON stock_movements(product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_company
  ON stock_movements(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_movements_reference
  ON stock_movements(reference_type, reference_id)
  WHERE reference_type IS NOT NULL;

COMMENT ON TABLE stock_movements IS
  'Log de movimentacao de estoque (entradas, saidas, ajustes). Compartilhado entre PDV (sales) e dental supplies. type aceita {in,out,entrada,saida,ajuste} por compatibilidade historica.';

COMMENT ON COLUMN stock_movements.type IS
  'Direcao do movimento. PDV usa {in,out}; dental_supplies usa {entrada,saida,ajuste}. Padronizar para ENUM em migration futura.';

COMMENT ON COLUMN stock_movements.reference_type IS
  'Tipo de origem: sale, sale_cancel, dental_supply_movement, manual_adjustment, etc.';
