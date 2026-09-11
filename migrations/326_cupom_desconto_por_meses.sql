-- ============================================================
-- AURA. — migration 326: cupom com desconto por varios meses
--
-- 11/09/2026: ate aqui o cupom do checkout (access_codes) so descontava a
-- PRIMEIRA mensalidade, e so em percentual. O pedido comercial e outro:
-- "R$ 50 de desconto nas 3 primeiras mensalidades do plano Negocio".
--
-- access_codes ganha:
--   discount_value    desconto em reais por mensalidade (alternativa ao pct)
--   discount_months   quantas mensalidades levam o desconto (1 = como hoje)
--   restrict_to_plan  true = o cupom so vale no plano da coluna `plan`.
--                     A coluna `plan` existe desde a 019 mas nunca foi
--                     conferida no checkout, e os cupons de indicacao (REF-*)
--                     foram criados com plan='essencial' so por default. Ligar
--                     a trava para todo mundo quebraria esses cupons; por isso
--                     ela e declarada por cupom.
--
-- subscription_discounts guarda o desconto EM ANDAMENTO de uma assinatura:
-- a assinatura no Asaas nasce com o valor descontado e a rotina diaria
-- (jobs/subscriptionDiscountJob.js) devolve o valor cheio depois que a
-- ultima mensalidade com desconto foi gerada, e avisa o cliente por e-mail
-- antes da primeira cobranca cheia.
--
-- Idempotente: pode rodar 2x sem quebrar.
-- ============================================================

ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS discount_months INTEGER NOT NULL DEFAULT 1;
ALTER TABLE access_codes ADD COLUMN IF NOT EXISTS restrict_to_plan BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  ALTER TABLE access_codes
    ADD CONSTRAINT access_codes_discount_value_chk CHECK (discount_value >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE access_codes
    ADD CONSTRAINT access_codes_discount_months_chk CHECK (discount_months BETWEEN 1 AND 24);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Auditoria do resgate: o que valeu na hora fica congelado aqui.
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE coupon_redemptions ADD COLUMN IF NOT EXISTS discount_months INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS subscription_discounts (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  code_id               UUID REFERENCES access_codes(id) ON DELETE SET NULL,
  code                  VARCHAR(64) NOT NULL,

  -- A assinatura a que o desconto pertence. Se a empresa trocar de
  -- assinatura (troca de plano, cancelamento), o desconto nao a acompanha.
  asaas_subscription_id VARCHAR(64) NOT NULL,
  billing_type          VARCHAR(32),

  -- Reais abatidos de cada mensalidade (so do plano).
  discount_amount       NUMERIC(10,2) NOT NULL,
  -- Total de mensalidades com desconto, contando a cobrada fora da
  -- assinatura (no cartao a 1a e cobrada na hora, avulsa: charged_upfront=1).
  months                INTEGER NOT NULL,
  charged_upfront       INTEGER NOT NULL DEFAULT 0,
  -- Vencimento previsto da primeira mensalidade cheia.
  first_full_due_date   DATE NOT NULL,

  -- active   = assinatura no Asaas ainda no valor descontado
  -- restored = valor cheio devolvido (as mensalidades com desconto ja
  --            geradas seguem com desconto ate vencerem)
  -- lost     = a empresa trocou de plano ou cancelou antes do fim
  status                VARCHAR(16) NOT NULL DEFAULT 'active',
  ended_reason          VARCHAR(32),
  -- Trava da rotina: quem pegou a linha e para qual valor a assinatura vai.
  -- Se o PUT no Asaas passou mas o UPDATE aqui falhou, a proxima rodada ve
  -- que a assinatura ja esta no valor alvo e nao soma o desconto de novo.
  restore_claimed_at    TIMESTAMPTZ,
  restore_target_value  NUMERIC(10,2),
  restored_at           TIMESTAMPTZ,
  notice_sent_at        TIMESTAMPTZ,
  notice_skipped        BOOLEAN NOT NULL DEFAULT false,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE subscription_discounts
    ADD CONSTRAINT subscription_discounts_status_chk CHECK (status IN ('active', 'restored', 'lost'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- No maximo um desconto em andamento por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_discounts_active_company
  ON subscription_discounts(company_id)
  WHERE status = 'active';

-- A rotina diaria so varre o que ainda tem trabalho (devolver valor ou avisar).
CREATE INDEX IF NOT EXISTS idx_subscription_discounts_pending
  ON subscription_discounts(status, first_full_due_date)
  WHERE status = 'active' OR (status = 'restored' AND notice_sent_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_subscription_discounts_company
  ON subscription_discounts(company_id, created_at DESC);
