-- ============================================================
-- AURA. Migration 019 — Access Codes (PAY/TRIAL/REF/PROMO)
-- Supports: payment codes, trial, referral, promo
-- ============================================================

CREATE TABLE IF NOT EXISTS access_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          VARCHAR(20) UNIQUE NOT NULL,
  type          VARCHAR(20) NOT NULL CHECK (type IN ('payment','trial','referral','promo')),
  plan          VARCHAR(20) DEFAULT 'essencial' CHECK (plan IN ('essencial','negocio','expansao')),
  discount_pct  INTEGER DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  trial_days    INTEGER DEFAULT 0,
  max_uses      INTEGER DEFAULT 1,
  uses          INTEGER DEFAULT 0,
  referrer_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_codes_code ON access_codes(code);
CREATE INDEX IF NOT EXISTS idx_access_codes_referrer ON access_codes(referrer_id);
CREATE INDEX IF NOT EXISTS idx_access_codes_type ON access_codes(type);

-- Referrals tracking table
CREATE TABLE IF NOT EXISTS referrals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  referred_email  VARCHAR(255),
  code            VARCHAR(20) NOT NULL,
  status          VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','completed','expired','cancelled')),
  discount_applied BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);

-- Add trial fields to companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS access_code_used VARCHAR(20);

-- Add is_staff to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_staff BOOLEAN DEFAULT false;

-- Seed: create a default TRIAL code for testing
INSERT INTO access_codes (code, type, plan, trial_days, max_uses, expires_at)
VALUES ('TRIAL-AURA', 'trial', 'negocio', 7, 9999, '2027-12-31T23:59:59Z')
ON CONFLICT (code) DO NOTHING;
