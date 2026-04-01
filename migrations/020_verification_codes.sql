-- ============================================================
-- AURA. Migration 020 — Email & Phone verification (OTP)
-- ============================================================

CREATE TABLE IF NOT EXISTS verification_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(10) NOT NULL CHECK (type IN ('email','phone')),
  code        VARCHAR(6) NOT NULL,
  destination VARCHAR(255) NOT NULL, -- email address or phone number
  attempts    INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 5,
  verified_at TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_verification_user ON verification_codes(user_id, type);
CREATE INDEX IF NOT EXISTS idx_verification_dest ON verification_codes(destination, code);

-- Add verified flags to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT false;
