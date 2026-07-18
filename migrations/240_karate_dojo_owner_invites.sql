-- ============================================================
-- AURA KARATÊ — Migration 240: karate_dojo_owner_invites (F0 Aura Dojô)
-- ------------------------------------------------------------
-- Convite para o "claim" da conta do dojô: quando a federação cadastra um
-- dojô (POST /federation/:id/dojos, ver src/routes/karateDojos.js), o owner
-- criado é um usuário de SISTEMA com senha '!locked-system-no-login'
-- ('Sistema Dojôs') — ou seja, NENHUM dojô da base consegue logar. O claim
-- convida o e-mail do sensei; ele define a senha no link público
-- (/public/karate/dojo-claim/*) e a company do dojô troca de owner
-- (UPDATE companies.owner_id) — ver src/services/karateDojoClaimService.js.
--
-- token_hash = SHA-256(token::segredo) — o token em claro NUNCA é
-- persistido (mesmo padrão de karate_dojo_portal_otps, migration 186).
-- TTL 7 dias; convite novo invalida os pendentes do mesmo dojô.
--
-- NUMERAÇÃO: 239 foi reservada para karate_dojo_portal_links (branch
-- paralela em desenvolvimento no mesmo dia, 17/07/2026) — por isso esta
-- é a 240, mesmo sendo a 238 a maior em main no momento do PR.
--
-- NÃO aplicada em produção neste PR (aplicar via MCP antes do deploy).
-- Idempotente / defensiva (IF NOT EXISTS + FKs em DO $$), padrão da 231.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_dojo_owner_invites (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dojo_id       uuid NOT NULL,
  federation_id uuid NOT NULL,
  email         text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- FKs defensivas (mesma filosofia da migration 231): CASCADE nas companies
-- (convite não sobrevive ao dojô/federação), SET NULL no autor.
DO $$ BEGIN
  ALTER TABLE karate_dojo_owner_invites
    ADD CONSTRAINT karate_dojo_owner_invites_dojo_id_fkey
    FOREIGN KEY (dojo_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_owner_invites
    ADD CONSTRAINT karate_dojo_owner_invites_federation_id_fkey
    FOREIGN KEY (federation_id) REFERENCES companies(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE karate_dojo_owner_invites
    ADD CONSTRAINT karate_dojo_owner_invites_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_karate_dojo_owner_invites_dojo
  ON karate_dojo_owner_invites (dojo_id);

COMMENT ON TABLE karate_dojo_owner_invites IS
  'Convite de claim da conta do dojô (F0 Aura Dojô): a federação convida o e-mail do sensei; o complete público troca companies.owner_id do user-sistema (!locked-system-no-login) para o owner real. token_hash=SHA-256(token::segredo), TTL 7 dias; convite novo invalida os pendentes do mesmo dojô.';
