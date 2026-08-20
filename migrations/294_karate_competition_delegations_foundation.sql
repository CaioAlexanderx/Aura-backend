-- ============================================================
-- AURA KARATÊ — Migration 294: FUNDAÇÃO P0 do Hub de Campeonatos
-- (divisões, grupos, equipes, delegações e precificação)
--
-- ORIGEM: Dossiê Shiai — tradução dos regulamentos reais da JKA-SP
-- (XXV Paulista + III Copa Aspirantes 2026) e FPKT (Paulista Pedreira
-- 2026) em modelo de dados. Quatro lacunas estruturais fechadas aqui:
--
--  1) DIVISÕES: o mesmo evento físico abriga "Campeonato Paulista
--     (Principal)" e "Copa Aspirantes" com regras/cotas/premiações
--     próprias → karate_competition_divisions, com `rules` jsonb (cotas
--     por clube por prova, observações de regulamento).
--  2) GRUPOS: cada categoria se subdivide por graduação ("Grupo 1 — até
--     6º kyu" / "Grupo 2 — 5º kyu e acima") → division_id + group_label
--     em karate_competition_categories (o corte de faixa continua nos
--     belt_min/belt_max já existentes).
--  3) EQUIPES: kata/kumite equipe são times com roster (3 titulares + 1
--     reserva; 5+1 no kumite adulto masc JKA; trios mistos na FPKT) →
--     karate_competition_teams + _team_members. A equipe entra na chave
--     como UMA entry (karate_competition_entries.team_id), então TODO o
--     motor de brackets existente funciona sem mudança de schema.
--  4) DELEGAÇÃO: quem inscreve num campeonato é o CLUBE, não o atleta —
--     planilha + comprovante + e-mail viram karate_delegation_orders
--     (carrinho consolidado com snapshot da cotação, modo de pagamento
--     Aura Pay / PIX direto / conferência manual de comprovante).
--
-- PRECIFICAÇÃO (karate_competitions.pricing_config jsonb):
--   { "individual": { "mode": "per_athlete"|"per_entry",
--       "bands": [ { "max_age": 14, "amount": 150 }, { "amount": 180 } ] },
--     "team":       { "per_prova": 125, "bundle_both": 250 },
--     "exemptions": { "officials_per_exemption": 2, "max_exemptions": 3 } }
--   "per_athlete" = taxa ÚNICA por atleta cobrindo N provas individuais
--   (regra JKA); bands por idade na DATA DO EVENTO. A engine de cotação é
--   src/services/karateCompetitionPricingService.js (pura, testada).
--
-- CICLO OPERACIONAL (karate_competitions):
--   conference_published_at  → planilha de conferência publicada no portal
--   rectification_deadline   → prazo final de retificação de chaves
--   brackets_published_at    → chaves publicadas no portal (fim do PDF
--                              no WhatsApp)
--
-- Idempotente de ponta a ponta (IF NOT EXISTS / DO $$ ... EXCEPTION).
-- Aplicar via Supabase MCP antes do merge (backend não roda migrations).
-- ============================================================

-- ── 1) Divisões ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS karate_competition_divisions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  sort_order     INT  NOT NULL DEFAULT 0,
  -- rules: { "max_individual_per_dojo_per_category": 7,
  --          "max_teams_per_dojo_per_category": 1,   -- por sexo
  --          "notes": "Regras adaptadas — ver regulamento" }
  rules          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, name)
);
CREATE INDEX IF NOT EXISTS idx_kcd_competition
  ON karate_competition_divisions(competition_id, sort_order);

DROP TRIGGER IF EXISTS trg_kcd_updated_at ON karate_competition_divisions;
CREATE TRIGGER trg_kcd_updated_at BEFORE UPDATE ON karate_competition_divisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_competition_divisions ENABLE ROW LEVEL SECURITY;

-- ── 2) Grupos nas categorias ────────────────────────────────
ALTER TABLE karate_competition_categories
  ADD COLUMN IF NOT EXISTS division_id UUID REFERENCES karate_competition_divisions(id) ON DELETE SET NULL;
ALTER TABLE karate_competition_categories
  ADD COLUMN IF NOT EXISTS group_label TEXT;

CREATE INDEX IF NOT EXISTS idx_kcc_division
  ON karate_competition_categories(division_id);

COMMENT ON COLUMN karate_competition_categories.group_label IS
  'Subdivisão por graduação dentro da categoria (ex.: "Grupo 1"). O corte de faixa em si vive em belt_min/belt_max; o label agrupa categorias-irmãs geradas da mesma matriz.';

-- ── 3) Delegações (pedido consolidado do clube) ─────────────
CREATE TABLE IF NOT EXISTS karate_delegation_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  competition_id  UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  dojo_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'submitted'
                    CHECK (status IN ('draft','submitted','awaiting_payment','awaiting_confirmation','paid','cancelled')),
  -- aura_pay   → subconta BaaS + split (contrato opcional, fase Aura Pay)
  -- pix_direct → PIX na conta da federação via provider já configurado
  -- manual     → transferência + comprovante + fila de conferência
  payment_mode    TEXT NOT NULL DEFAULT 'manual'
                    CHECK (payment_mode IN ('aura_pay','pix_direct','manual')),
  -- Snapshot IMUTÁVEL da cotação no submit (linhas, isenções, total) — o
  -- que o dojô viu e aceitou. Recalcular preço depois nunca muda o pedido.
  quote           JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Nº de oficiais (árbitros/mesários/staff) declarados pelo clube — base
  -- das isenções por contrapartida; a federação valida na conferência.
  officials_count INT NOT NULL DEFAULT 0,
  receipt_url     TEXT,
  receipt_uploaded_at TIMESTAMPTZ,
  created_by      UUID,
  created_by_name TEXT,
  confirmed_by    UUID,
  confirmed_by_name TEXT,
  confirmed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kdo_federation_comp
  ON karate_delegation_orders(federation_id, competition_id, status);
CREATE INDEX IF NOT EXISTS idx_kdo_dojo
  ON karate_delegation_orders(dojo_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_kdo_updated_at ON karate_delegation_orders;
CREATE TRIGGER trg_kdo_updated_at BEFORE UPDATE ON karate_delegation_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_delegation_orders ENABLE ROW LEVEL SECURITY;

-- ── 4) Equipes ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS karate_competition_teams (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id      UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  category_id         UUID NOT NULL REFERENCES karate_competition_categories(id) ON DELETE CASCADE,
  dojo_id             UUID REFERENCES companies(id) ON DELETE SET NULL,
  name                TEXT NOT NULL,
  sex                 TEXT NOT NULL DEFAULT 'mixed' CHECK (sex IN ('M','F','mixed')),
  status              TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','withdrawn')),
  delegation_order_id UUID REFERENCES karate_delegation_orders(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kct_category
  ON karate_competition_teams(category_id, status);
CREATE INDEX IF NOT EXISTS idx_kct_dojo
  ON karate_competition_teams(dojo_id);

DROP TRIGGER IF EXISTS trg_kct_updated_at ON karate_competition_teams;
CREATE TRIGGER trg_kct_updated_at BEFORE UPDATE ON karate_competition_teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_competition_teams ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS karate_competition_team_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    UUID NOT NULL REFERENCES karate_competition_teams(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'titular' CHECK (role IN ('titular','reserva')),
  sort_order INT  NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_kctm_team
  ON karate_competition_team_members(team_id, sort_order);

ALTER TABLE karate_competition_team_members ENABLE ROW LEVEL SECURITY;

-- ── 5) Entries: equipe entra na chave como UMA entry ────────
-- student_id vira nullable; a entry aponta OU para um atleta OU para uma
-- equipe. O UNIQUE(category_id, student_id) original continua valendo para
-- individuais (NULLs não conflitam); o índice parcial abaixo faz o par
-- para equipes. Todo o motor de brackets (aka/shiro/winner por entry_id)
-- funciona sem mudança.
ALTER TABLE karate_competition_entries
  ALTER COLUMN student_id DROP NOT NULL;

ALTER TABLE karate_competition_entries
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES karate_competition_teams(id) ON DELETE CASCADE;
ALTER TABLE karate_competition_entries
  ADD COLUMN IF NOT EXISTS delegation_order_id UUID REFERENCES karate_delegation_orders(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE karate_competition_entries
    ADD CONSTRAINT karate_comp_entries_subject_check
    CHECK (student_id IS NOT NULL OR team_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_kce_category_team_unique
  ON karate_competition_entries(category_id, team_id)
  WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kce_delegation_order
  ON karate_competition_entries(delegation_order_id)
  WHERE delegation_order_id IS NOT NULL;

-- ── 6) Competição: precificação + ciclo operacional ─────────
ALTER TABLE karate_competitions
  ADD COLUMN IF NOT EXISTS pricing_config JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE karate_competitions
  ADD COLUMN IF NOT EXISTS conference_published_at TIMESTAMPTZ;
ALTER TABLE karate_competitions
  ADD COLUMN IF NOT EXISTS rectification_deadline DATE;
ALTER TABLE karate_competitions
  ADD COLUMN IF NOT EXISTS brackets_published_at TIMESTAMPTZ;

COMMENT ON COLUMN karate_competitions.pricing_config IS
  'Regras de precificação da competição (ver cabeçalho da migration 294 e karateCompetitionPricingService). Vazio = usa fee_amount legado por inscrição.';

-- ============================================================
-- FIM DA MIGRATION 294
-- ============================================================
