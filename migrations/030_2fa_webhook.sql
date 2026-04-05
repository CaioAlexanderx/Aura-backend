-- ============================================================
-- AURA. Migration 030 — S10: 2FA TOTP + Webhook secrets
-- SEC-07: Two-factor authentication
-- BE-07: Webhook HMAC secrets per company
-- ============================================================

-- SEC-07: 2FA fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS backup_codes JSONB;

-- BE-07: Webhook secrets for integrations
ALTER TABLE companies ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(128);
