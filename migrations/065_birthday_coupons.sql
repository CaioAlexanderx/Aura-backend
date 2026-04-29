-- ============================================================
-- AURA. — Migration 065: Cupons de aniversário + envio
-- ============================================================
-- Habilita o fluxo "card aniversariantes do dia → cupom →
-- mensagem WhatsApp" no painel violeta.
--
-- Mudanças:
--   0. coupons       : CREATE TABLE base (não existia antes desta migration)
--   1. coupons       : customer_id, source (rastreio de origem)
--   2. customers     : marketing_opt_out (LGPD)
--   3. companies     : birthday_coupon_defaults (JSONB),
--                       birthday_message_template (TEXT)
--   4. birthday_messages_sent (NEW): histórico por envio
--
-- Padrão idempotente: ALTER ... ADD COLUMN IF NOT EXISTS,
-- CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- ============================================================

-- 0. Base da tabela coupons (criada aqui pela primeira vez)
CREATE TABLE IF NOT EXISTS coupons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  discount_type   TEXT NOT NULL DEFAULT 'percent'
                    CHECK (discount_type IN ('percent', 'fixed')),
  discount_value  NUMERIC(10,2) NOT NULL DEFAULT 0,
  min_order_value NUMERIC(10,2) NULL,
  max_discount    NUMERIC(10,2) NULL,
  valid_from      TIMESTAMPTZ NULL,
  valid_until     TIMESTAMPTZ NULL,
  max_uses        INT NULL,
  uses_count      INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  description     TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_coupons_company_id
  ON coupons(company_id);

CREATE INDEX IF NOT EXISTS idx_coupons_valid_until
  ON coupons(valid_until) WHERE valid_until IS NOT NULL;

-- 1. coupons: marcação de origem e vínculo opcional ao cliente
ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS customer_id UUID NULL
    REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE coupons
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- Constraint segura — drop-then-add pra idempotência sob check existente
ALTER TABLE coupons
  DROP CONSTRAINT IF EXISTS coupons_source_check;

ALTER TABLE coupons
  ADD CONSTRAINT coupons_source_check
  CHECK (source IN ('manual', 'birthday', 'campaign', 'reactivation'));

CREATE INDEX IF NOT EXISTS idx_coupons_company_source
  ON coupons(company_id, source);

CREATE INDEX IF NOT EXISTS idx_coupons_company_customer
  ON coupons(company_id, customer_id)
  WHERE customer_id IS NOT NULL;

-- 2. customers: opt-out de marketing (LGPD)
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false;

-- 3. companies: defaults persistidos por empresa
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS birthday_coupon_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS birthday_message_template TEXT NULL;

-- 4. histórico de envios — usado pelo card pra mostrar "✓ enviado"
--    e impedir re-disparo no mesmo aniversário
CREATE TABLE IF NOT EXISTS birthday_messages_sent (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  coupon_id   UUID NULL     REFERENCES coupons(id)   ON DELETE SET NULL,
  method      TEXT NOT NULL DEFAULT 'wa_link',
  -- birthday_year: pra distinguir "enviou em 2026" vs "enviou em 2027"
  -- e permitir reenvio no aniversário do ano seguinte
  birthday_year INT NOT NULL,
  user_id     UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  message     TEXT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE birthday_messages_sent
  DROP CONSTRAINT IF EXISTS birthday_messages_sent_method_check;

ALTER TABLE birthday_messages_sent
  ADD CONSTRAINT birthday_messages_sent_method_check
  CHECK (method IN ('wa_link', 'wa_api', 'sms', 'email'));

-- Índice principal: lookup rápido "esse cliente já recebeu este ano?"
CREATE UNIQUE INDEX IF NOT EXISTS uq_birthday_sent_per_year
  ON birthday_messages_sent(company_id, customer_id, birthday_year);

CREATE INDEX IF NOT EXISTS idx_birthday_sent_company_recent
  ON birthday_messages_sent(company_id, sent_at DESC);
