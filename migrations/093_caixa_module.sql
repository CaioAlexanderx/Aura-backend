-- ============================================================================
-- 093_caixa_module.sql — Módulo de Abertura/Fechamento de Caixa
-- ============================================================================
-- Cria as tabelas caixa_sessoes e caixa_fechamentos.
-- Adiciona sessao_id (nullable) em sale_payments para vínculo preciso.
-- Adiciona caixa_enabled: false no default de pdv_settings (opt-in).
--
-- Multi-CNPJ: cada sessão pertence a um company_id — o suporte a 2 CNPJs
-- é automático, pois tudo já é escopado por company_id no sistema.
-- ============================================================================

-- ── 1. Tabela principal de sessões ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS caixa_sessoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  opened_by       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  closed_by       UUID REFERENCES users(id) ON DELETE RESTRICT,

  opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at       TIMESTAMPTZ,

  troco_inicial   NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (troco_inicial >= 0),
  status          TEXT NOT NULL DEFAULT 'aberta'
                    CHECK (status IN ('aberta', 'fechada')),
  observacao      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Garante no máximo 1 sessão aberta por empresa a qualquer momento
CREATE UNIQUE INDEX IF NOT EXISTS uq_caixa_sessao_aberta_por_empresa
  ON caixa_sessoes(company_id)
  WHERE status = 'aberta';

CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_company_opened
  ON caixa_sessoes(company_id, opened_at DESC);

ALTER TABLE caixa_sessoes ENABLE ROW LEVEL SECURITY;

-- ── 2. Tabela de fechamento (snapshot imutável) ────────────────────────────

CREATE TABLE IF NOT EXISTS caixa_fechamentos (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sessao_id             UUID NOT NULL UNIQUE
                          REFERENCES caixa_sessoes(id) ON DELETE CASCADE,

  -- Confronto de dinheiro físico
  dinheiro_esperado     NUMERIC(12,2) NOT NULL,
  dinheiro_contado      NUMERIC(12,2) NOT NULL CHECK (dinheiro_contado >= 0),
  diferenca             NUMERIC(12,2) GENERATED ALWAYS AS
                          (dinheiro_contado - dinheiro_esperado) STORED,

  -- Totais por forma de pagamento (snapshot no momento do fechamento)
  total_pix             NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cartao_debito   NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_cartao_credito  NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_fiado           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_dinheiro        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_outros          NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_geral           NUMERIC(12,2) NOT NULL DEFAULT 0,

  observacao            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE caixa_fechamentos ENABLE ROW LEVEL SECURITY;

-- ── 3. Vínculo de sale_payments com a sessão ──────────────────────────────
-- Nullable: vendas sem sessão aberta ficam com NULL (sem bloqueio).
-- O backend preenche automaticamente ao registrar a venda.

ALTER TABLE sale_payments
  ADD COLUMN IF NOT EXISTS sessao_id UUID
    REFERENCES caixa_sessoes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sale_payments_sessao
  ON sale_payments(sessao_id)
  WHERE sessao_id IS NOT NULL;

-- ── 4. Toggle caixa_enabled em pdv_settings ───────────────────────────────
-- Backfill: adiciona caixa_enabled: false em todas as empresas existentes.
-- Empresas novas recebem o default via pdvSettings.js (DEFAULT_SETTINGS).

UPDATE companies
SET pdv_settings = COALESCE(pdv_settings, '{}'::jsonb) || '{"caixa_enabled": false}'::jsonb
WHERE pdv_settings IS NULL
   OR pdv_settings->>'caixa_enabled' IS NULL;

-- ── 5. Comments ───────────────────────────────────────────────────────────

COMMENT ON TABLE caixa_sessoes IS
  'Sessões de caixa por empresa. Máx. 1 aberta por company_id a qualquer momento.';
COMMENT ON TABLE caixa_fechamentos IS
  'Snapshot imutável do fechamento de caixa. Criado uma vez, nunca alterado.';
COMMENT ON COLUMN caixa_fechamentos.diferenca IS
  'Positivo = sobra, negativo = falta. Calculado automaticamente pelo banco.';
COMMENT ON COLUMN sale_payments.sessao_id IS
  'Sessão de caixa à qual este pagamento pertence. NULL se caixa não estava aberto.';
