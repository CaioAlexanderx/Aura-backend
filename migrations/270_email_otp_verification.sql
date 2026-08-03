-- ============================================================
-- AURA. Migration 270 — Codigo OTP de 6 digitos p/ confirmacao de e-mail
-- (task Sign Up 03/08/2026)
--
-- verification.js passa a gravar, junto com o token de link
-- (type='email'), um codigo digitavel de 6 digitos (type='email_otp')
-- validado por POST /auth/verify-email. Este arquivo:
--   1. inclui 'email_otp' no CHECK de type;
--   2. garante largura da coluna code para o token hex de 64 chars
--      (producao ja esta em VARCHAR(128); local/CI pode estar em 6);
--   3. indice para buscar o codigo mais recente por usuario.
-- Idempotente. O codigo em verification.js e defensivo (23514) e
-- funciona em modo so-link enquanto esta migration nao for aplicada.
-- ============================================================

ALTER TABLE verification_codes DROP CONSTRAINT IF EXISTS verification_codes_type_check;
ALTER TABLE verification_codes ADD CONSTRAINT verification_codes_type_check
  CHECK (type IN ('email', 'phone', 'email_otp'));

DO $$ BEGIN
  ALTER TABLE verification_codes ALTER COLUMN code TYPE VARCHAR(128);
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_verification_user_created
  ON verification_codes(user_id, type, created_at DESC);
