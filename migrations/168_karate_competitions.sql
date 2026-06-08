-- ============================================================
-- AURA KARATÊ — Migration 168: Competições + Categorias (Track E)
-- karate_competitions + karate_competition_categories.
-- Numeração real: segue 167_credit_late_charges_toggle (última aplicada).
-- Aplicada no Supabase hawtujkztrjpvvkihowb.
--
-- Modelagem (plano §2 Competições):
--   competição -> N categorias (faixa etária + kyu/dan + modalidade + peso + sexo)
--   taxa pode ser por competição (default) e/ou por categoria (override).
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_competitions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  season         INT  NOT NULL,
  event_date     DATE,
  location       TEXT,
  circuit_round  INT,
  fee_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed','done','cancelled')),
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_karate_competitions_federation
  ON karate_competitions(federation_id, season DESC, event_date DESC);

CREATE TABLE IF NOT EXISTS karate_competition_categories (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  modality       TEXT NOT NULL CHECK (modality IN ('kata','kumite','kihon_ippon','team_kata','team_kumite')),
  min_age        INT,
  max_age        INT,
  belt_min       TEXT,
  belt_max       TEXT,
  sex            TEXT NOT NULL DEFAULT 'mixed' CHECK (sex IN ('M','F','mixed')),
  weight_class   TEXT,
  max_entries    INT,
  fee_amount     NUMERIC(12,2),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_karate_comp_categories_competition
  ON karate_competition_categories(competition_id);

DROP TRIGGER IF EXISTS trg_karate_competitions_updated_at ON karate_competitions;
CREATE TRIGGER trg_karate_competitions_updated_at BEFORE UPDATE ON karate_competitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_karate_comp_categories_updated_at ON karate_competition_categories;
CREATE TRIGGER trg_karate_comp_categories_updated_at BEFORE UPDATE ON karate_competition_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_competitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE karate_competition_categories ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 168
