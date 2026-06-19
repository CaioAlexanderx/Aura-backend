-- ============================================================
-- AURA KARATÊ — Migration 186: Keystone de acesso do dojô (Canal B + filiação)
-- Numeração real: segue 185_companies_name_slug.
--
-- Duas tabelas novas, ambas aditivas e idempotentes (defensivas 42P01):
--
-- 1) karate_dojo_portal_access — credencial de LINK FIXO não-expirável do
--    dojô SEM Aura (Canal B). O sensei entra por um link permanente enviado
--    pela federação (WhatsApp/e-mail). Escopo restrito (consulta + pagar
--    anuidade); revogável/rotacionável. O token NUNCA é guardado em claro —
--    só o hash sha256 + um prefixo curto p/ exibição mascarada (mesmo padrão
--    de karate_dojo_connections.sync_token_hash).
--
-- 2) karate_affiliation_requests — auto-filiação com pré-aceite ANTES do
--    pagamento: solicitada → em_análise → (aprovada → aguardando_pagamento →
--    PIX → ativa) | recusada(motivo). O dojo_id só é preenchido na aprovação
--    (quando a company do dojô é criada/vinculada). A ativação é disparada no
--    confirm do pagamento da 1ª anuidade (hook idempotente em karateAnnuities).
-- ============================================================

-- ── 1) Credencial de link fixo do dojô (Canal B) ───────────────────────────
CREATE TABLE IF NOT EXISTS karate_dojo_portal_access (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dojo_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL,
  token_prefix    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','revoked')),
  issued_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  rotated_at      TIMESTAMPTZ,
  last_access_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 1 credencial por dojô; rotacionar substitui o hash da mesma linha.
  UNIQUE (dojo_id)
);
-- Lookup do guard: o token apresentado é hasheado e casado aqui.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dojo_portal_token_hash
  ON karate_dojo_portal_access(token_hash);
CREATE INDEX IF NOT EXISTS idx_dojo_portal_federation
  ON karate_dojo_portal_access(federation_id, status);

DROP TRIGGER IF EXISTS trg_dojo_portal_updated_at ON karate_dojo_portal_access;
CREATE TRIGGER trg_dojo_portal_updated_at BEFORE UPDATE ON karate_dojo_portal_access
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_dojo_portal_access ENABLE ROW LEVEL SECURITY;

-- ── 2) Solicitações de filiação (pré-aceite antes do pagamento) ─────────────
CREATE TABLE IF NOT EXISTS karate_affiliation_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id       UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- só preenchido quando aprovada (company do dojô criada/vinculada):
  dojo_id             UUID REFERENCES companies(id) ON DELETE SET NULL,
  dojo_name           TEXT NOT NULL,
  cnpj                TEXT,
  sensei_name         TEXT,
  sensei_cpf          TEXT,
  contact_email       TEXT,
  contact_phone       TEXT,
  region              TEXT,
  affiliation_model   TEXT
                        CHECK (affiliation_model IN ('annual','biannual','quarterly')
                               OR affiliation_model IS NULL),
  status              TEXT NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested','under_review','awaiting_payment','activated','rejected')),
  -- a 1ª anuidade + intent gerados na aprovação (linkam o hook de ativação):
  annuity_history_id  UUID,
  payment_intent_id   UUID,
  fpkt_affiliation_id TEXT,
  rejection_reason    TEXT,
  reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  activated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_affiliation_req_federation
  ON karate_affiliation_requests(federation_id, status);
CREATE INDEX IF NOT EXISTS idx_affiliation_req_dojo
  ON karate_affiliation_requests(dojo_id);

DROP TRIGGER IF EXISTS trg_affiliation_req_updated_at ON karate_affiliation_requests;
CREATE TRIGGER trg_affiliation_req_updated_at BEFORE UPDATE ON karate_affiliation_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_affiliation_requests ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- FIM DA MIGRATION 186
-- ============================================================
