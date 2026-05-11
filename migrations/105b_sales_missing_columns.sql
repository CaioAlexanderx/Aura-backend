-- ============================================================
-- Migration 105b — Colunas faltantes em sales (CI fix)
-- Data: 2026-05-11
--
-- Contexto: o CI do GitHub Actions roda as migrations do zero contra
-- um banco fresco. Quebrou na migration 106 com "column s.status does
-- not exist" porque varias colunas de sales foram adicionadas em
-- producao via ALTER manual (Supabase MCP / hot-fix) sem migration
-- commitada no repo.
--
-- Esta migration adiciona TODAS essas colunas idempotentemente. Numerada
-- como 105b para rodar imediatamente antes da 106 (ls | sort aplica
-- 105 < 105b < 106).
--
-- Em producao todas as colunas ja existem (default values e nullability
-- batem). IF NOT EXISTS torna este script um no-op em prod.
-- ============================================================

-- status: 'completed' | 'cancelled' (varchar; controla soft-delete)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS status VARCHAR DEFAULT 'completed';

-- cancelled_at + cancelled_by: auditoria do cancelamento
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS cancelled_by UUID NULL;

-- seller_name: nome desnormalizado (plano Essencial - sem cadastro de
-- funcionarios obrigatorio); fallback exibicao se employee deletado
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS seller_name TEXT NULL;

-- coupon_id + coupon_code: cupom aplicado (FK em coupons + codigo desnormalizado)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS coupon_id UUID NULL;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS coupon_code VARCHAR NULL;

-- employee_id: vendedora atribuida via cadastro Equipe (separado de seller_id user)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS employee_id UUID NULL;

-- product_name_snapshot: legado, mantido pra retro-compat (snapshot da venda)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS product_name_snapshot TEXT NULL;

-- cash_tendered: legado (modal de troco nao persiste mais; mantido pra retro-compat)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS cash_tendered NUMERIC NULL;

-- pix_payload: BR Code completo da venda Pix (caso emitido na NFC-e)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS pix_payload TEXT NULL;

-- updated_at: timestamp de ultima atualizacao (usado pelo trigger set_updated_at)
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Indices uteis (idempotentes)
CREATE INDEX IF NOT EXISTS idx_sales_status
  ON sales (company_id, status)
  WHERE status != 'completed';

CREATE INDEX IF NOT EXISTS idx_sales_cancelled
  ON sales (company_id, cancelled_at)
  WHERE cancelled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_employee
  ON sales (employee_id)
  WHERE employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sales_coupon
  ON sales (coupon_id)
  WHERE coupon_id IS NOT NULL;

-- Trigger pra atualizar updated_at automaticamente
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sales_updated_at'
  ) THEN
    CREATE TRIGGER trg_sales_updated_at
      BEFORE UPDATE ON sales
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;

COMMENT ON COLUMN sales.status IS
  'Status soft-delete: completed (default) | cancelled. Cancelamentos preservam o registro pra auditoria.';

COMMENT ON COLUMN sales.cancelled_at IS
  'Timestamp do cancelamento (NULL para vendas ativas).';

COMMENT ON COLUMN sales.employee_id IS
  'FK em employees (cadastro Equipe). Distinto de seller_id (FK em users) que vincula ao login.';

-- Sanity check
DO $$
DECLARE
  cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO cnt
  FROM information_schema.columns
  WHERE table_name = 'sales'
    AND column_name IN (
      'status', 'cancelled_at', 'cancelled_by', 'seller_name',
      'coupon_id', 'coupon_code', 'employee_id',
      'product_name_snapshot', 'cash_tendered', 'pix_payload', 'updated_at'
    );

  RAISE NOTICE '[migration 105b] sales tem %/11 colunas esperadas', cnt;
END
$$;
