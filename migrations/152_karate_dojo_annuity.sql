-- ============================================================
-- AURA KARATÊ — Migration 152: Histórico de Anuidades de Dojô
-- Tabela para registrar pagamentos de anuidades (afiliação) por dojô.
-- Usada por:
--   - GET /federation/:id/dojos/:dojoId → annuity_history
--   - Dashboard overdue_dojos → amount + days_overdue
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_annuity_history (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- FK para o dojô
  dojo_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Federação (desnormalizado para queries diretas)
  federation_id    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Período de referência (ex: '2025', '2025-Q1', '2025-H1')
  reference_period TEXT NOT NULL,

  -- Valor cobrado
  amount           NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Data efetiva do pagamento (NULL = não pago / pendente)
  paid_at          DATE,

  -- Status computado da anuidade
  -- active    = pago em dia
  -- overdue   = não pago, < 90 dias de atraso
  -- defaulting = não pago, 90-180 dias
  -- suspended  = não pago, > 180 dias
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'expiring', 'overdue', 'defaulting', 'suspended')),

  -- Data de vencimento desta anuidade
  due_date         DATE,

  -- Metadados
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_karate_annuity_updated_at
  BEFORE UPDATE ON karate_dojo_annuity_history
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_karate_annuity_dojo
  ON karate_dojo_annuity_history(dojo_id, reference_period DESC);

CREATE INDEX IF NOT EXISTS idx_karate_annuity_federation
  ON karate_dojo_annuity_history(federation_id, status);

-- ============================================================
-- FIM DA MIGRATION 152
-- ============================================================
