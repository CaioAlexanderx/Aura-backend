-- ============================================================
-- AURA. — migration 228: coupon_redemptions
--
-- 13/07/2026: cupom de desconto / dias gratis passa a valer DE VERDADE no
-- checkout (/companies/:id/billing/subscribe). Antes, access_codes.discount_pct
-- e trial_days so eram lidos no /auth/register — e o discount_pct nem la era
-- aplicado a cobranca: virava um campo na resposta JSON e morria ali.
--
-- Agora existe dinheiro envolvido, entao existe trilha de auditoria:
-- quem resgatou, qual codigo, quanto seria o valor cheio, quanto foi cobrado.
--
-- Idempotente (padrao do repo): pode rodar 2x sem quebrar.
-- ============================================================

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  code_id               UUID REFERENCES access_codes(id) ON DELETE SET NULL,
  code                  VARCHAR(64)  NOT NULL,
  type                  VARCHAR(32),

  -- Efeitos aplicados (copiados no momento do resgate — o access_code pode
  -- mudar depois; o que valeu na hora fica congelado aqui).
  discount_pct          INTEGER NOT NULL DEFAULT 0,
  trial_days            INTEGER NOT NULL DEFAULT 0,

  -- Contexto da assinatura
  plan                  VARCHAR(32),
  cycle                 VARCHAR(16),
  billing_type          VARCHAR(32),

  -- Dinheiro: valor cheio da recorrencia x valor efetivamente cobrado na 1a.
  -- charged_value NULL = nao houve cobranca imediata (cupom de dias gratis).
  recurring_value       NUMERIC(10,2),
  charged_value         NUMERIC(10,2),

  asaas_payment_id      VARCHAR(64),
  asaas_subscription_id VARCHAR(64),

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_company ON coupon_redemptions(company_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_code    ON coupon_redemptions(code_id);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_created ON coupon_redemptions(created_at DESC);

-- Ultima linha de defesa contra resgate duplo da MESMA empresa no MESMO cupom.
-- A checagem no codigo (checkoutCoupon.validateCoupon) e a primeira; esta aqui
-- fecha a corrida entre dois checkouts simultaneos.
CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_redemption_company_code
  ON coupon_redemptions(company_id, code_id)
  WHERE code_id IS NOT NULL;
