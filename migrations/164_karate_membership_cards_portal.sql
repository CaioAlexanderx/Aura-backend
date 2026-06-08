-- ============================================================
-- Aura Karatê — Fase 3 / Track D
-- Carteirinha digital (DATA-ONLY: sem geração de imagem no app),
-- portal do praticante (OTP) e opt-in de portal público.
-- NOTA DE NUMERAÇÃO: 163 já está ocupado por
-- 163_credit_phase1_version_schema → esta migration é 164.
-- RLS habilitado sem policies (padrão do projeto; acesso mediado
-- pelo backend via service_role; rotas públicas mediadas por token).
-- ============================================================

-- ── Carteirinha digital ────────────────────────────────────
CREATE TABLE IF NOT EXISTS karate_membership_cards (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id       uuid NOT NULL,
  student_id          uuid NOT NULL,
  card_number         text NOT NULL,             -- snapshot de karate_registration_number
  belt_snapshot       text,                      -- belt_level no momento da emissão
  belt_name_snapshot  text,                      -- cor/nome no momento da emissão
  dojo_id             uuid,
  dojo_name_snapshot  text,
  photo_url_snapshot  text,
  is_minor            boolean NOT NULL DEFAULT false,
  issued_by           uuid,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  valid_until         timestamptz NOT NULL,
  verify_token        text NOT NULL UNIQUE,      -- opaco; utilidade expira junto com o cartão
  status              text NOT NULL DEFAULT 'active',  -- active | expired | revoked
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kmc_student      ON karate_membership_cards(student_id);
CREATE INDEX IF NOT EXISTS idx_kmc_federation   ON karate_membership_cards(federation_id);
CREATE INDEX IF NOT EXISTS idx_kmc_verify_token ON karate_membership_cards(verify_token);
-- No máximo 1 carteirinha 'active' por praticante (renovar expira/revoga a anterior)
CREATE UNIQUE INDEX IF NOT EXISTS uq_kmc_active_per_student
  ON karate_membership_cards(student_id) WHERE status = 'active';
ALTER TABLE karate_membership_cards ENABLE ROW LEVEL SECURITY;

-- ── Portal do praticante: opt-in público + token compartilhável ──
-- public_token só é preenchido quando public_opt_in = true E não-menor.
CREATE TABLE IF NOT EXISTS karate_practitioner_portal (
  student_id     uuid PRIMARY KEY,
  federation_id  uuid NOT NULL,
  public_opt_in  boolean NOT NULL DEFAULT false,
  public_token   text UNIQUE,
  opt_in_at      timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE karate_practitioner_portal ENABLE ROW LEVEL SECURITY;

-- ── OTP do portal (autenticação do praticante) ─────────────
-- code_hash = sha256(code + PORTAL_OTP_SECRET). Nunca armazenar o código em claro.
CREATE TABLE IF NOT EXISTS karate_portal_otps (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id     uuid NOT NULL,
  student_id        uuid,
  channel           text NOT NULL,            -- whatsapp | email
  destination_hint  text,                     -- mascarado para UI (ex: a***@g***.com)
  code_hash         text NOT NULL,
  attempts          int  NOT NULL DEFAULT 0,
  max_attempts      int  NOT NULL DEFAULT 5,
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kpo_student ON karate_portal_otps(student_id);
CREATE INDEX IF NOT EXISTS idx_kpo_expires ON karate_portal_otps(expires_at);
ALTER TABLE karate_portal_otps ENABLE ROW LEVEL SECURITY;
