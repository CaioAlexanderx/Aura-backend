-- ============================================================
-- 353 — Matcon M3: Profissionais Parceiros (clube do profissional)
--
-- Contexto (23/09/2026): na loja de material de construcao quem traz o
-- cliente e o pedreiro, o eletricista, o arquiteto. A loja marca esse
-- cliente como "profissional parceiro"; toda venda que ele indicar (chip
-- "Indicado por" do Caixa) rende pontos, e os pontos viram cupom de
-- desconto para ele usar na propria loja. Contrato: aura-app
-- docs/CONTRACT_MATCON.md, secao M3. As regras numericas moram em
-- companies.pdv_settings (matcon_points_per_100, matcon_points_to_coupon,
-- matcon_coupon_value, matcon_club_enabled) — jsonb, sem migration.
--
-- DECISOES:
-- - O profissional E um cliente marcado: 1:1 com customers, por loja
--   (UNIQUE company_id + customer_id). Clientes sao do dono (multi-CNPJ),
--   mas pontos e cupom sao de UMA loja: o mesmo pedreiro pode ser parceiro
--   da loja A e nao da B, com saldos separados.
-- - `trade` sem CHECK no banco: a lista de profissoes e validada na rota
--   (src/routes/matconProfessionals.js), como as unidades do M0. Profissao
--   nova nao precisa de migration.
-- - `points_balance` PODE ficar negativo, de proposito: se a venda indicada
--   for cancelada depois que os pontos ja viraram cupom, o estorno debita
--   mesmo assim e as proximas indicacoes cobrem a diferenca. Travar em zero
--   daria pontos de graca; recusar o cancelamento prenderia a loja.
-- - Saldo e contadores ficam desnormalizados na linha do profissional (a
--   lista e um ranking lido toda hora); a verdade auditavel e o extrato
--   matcon_professional_points_ledger.
-- - Extrato: `reason` = sale (credito da venda indicada), redeem (resgate
--   em cupom), adjust (estorno de venda cancelada, ou ajuste manual). Um
--   credito e um estorno por venda, no maximo — o indice unico parcial
--   torna o credito/estorno idempotente (o PDV pode repetir o hook).
-- - `sale_total` no extrato guarda o total que gerou os pontos, para o
--   estorno desfazer exatamente o que o credito somou.
-- - sales.referred_by_professional_id: nullable, ON DELETE SET NULL. Venda
--   sem indicacao continua exatamente como hoje.
-- - coupons.source ganha 'matcon_professional' (cupom do resgate: valor
--   fixo, uso unico, nominal ao cliente do profissional).
-- ============================================================

CREATE TABLE IF NOT EXISTS matcon_professionals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  trade                 TEXT NOT NULL DEFAULT 'outro',
  points_balance        INTEGER NOT NULL DEFAULT 0,
  points_earned_total   INTEGER NOT NULL DEFAULT 0,
  referrals_count       INTEGER NOT NULL DEFAULT 0,
  referred_sales_total  NUMERIC(12,2) NOT NULL DEFAULT 0,
  last_referral_at      TIMESTAMPTZ NULL,
  active                BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT matcon_professionals_company_customer_key UNIQUE (company_id, customer_id)
);

-- A lista de clientes pergunta "estes clientes sao parceiros desta loja?"
-- (company_id, customer_id) — atendida pelo UNIQUE acima. Este indice serve
-- o ranking (ativos por saldo) e o "cupons pra gerar".
CREATE INDEX IF NOT EXISTS idx_matcon_professionals_company_active
  ON matcon_professionals (company_id, active, points_balance DESC);

CREATE TABLE IF NOT EXISTS matcon_professional_points_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  professional_id  UUID NOT NULL REFERENCES matcon_professionals(id) ON DELETE CASCADE,
  sale_id          UUID NULL REFERENCES sales(id) ON DELETE SET NULL,
  coupon_id        UUID NULL REFERENCES coupons(id) ON DELETE SET NULL,
  delta            INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  sale_total       NUMERIC(12,2) NULL,
  note             TEXT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT matcon_professional_points_ledger_reason_check
    CHECK (reason IN ('sale', 'redeem', 'adjust'))
);

CREATE INDEX IF NOT EXISTS idx_matcon_points_ledger_professional
  ON matcon_professional_points_ledger (professional_id, created_at DESC);

-- Um credito (sale) e um estorno (adjust) por venda, no maximo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_matcon_points_ledger_sale_reason
  ON matcon_professional_points_ledger (sale_id, reason)
  WHERE sale_id IS NOT NULL;

-- Venda indicada
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS referred_by_professional_id UUID NULL
    REFERENCES matcon_professionals(id) ON DELETE SET NULL;

-- "Ultimas indicacoes" da ficha e o total do mes do ranking.
CREATE INDEX IF NOT EXISTS idx_sales_referred_by_professional
  ON sales (referred_by_professional_id, created_at DESC)
  WHERE referred_by_professional_id IS NOT NULL;

-- Cupom do resgate
ALTER TABLE coupons
  DROP CONSTRAINT IF EXISTS coupons_source_check;

ALTER TABLE coupons
  ADD CONSTRAINT coupons_source_check
  CHECK (source IN ('manual', 'birthday', 'campaign', 'reactivation', 'credit_lead', 'matcon_professional'));

COMMENT ON TABLE matcon_professionals IS 'Matcon M3: cliente marcado como profissional parceiro da loja (pontos por venda indicada).';
COMMENT ON COLUMN sales.referred_by_professional_id IS 'Matcon M3: profissional parceiro que indicou a venda. NULL = sem indicacao.';
