-- ============================================================
-- Migration 183 — Karate Brackets (Track M)
-- karate_brackets: chave de uma categoria (draft|locked)
-- karate_bracket_matches: partidas individuais (kumite)
-- karate_kata_scores: notas por bateria (kata)
-- Idempotente via IF NOT EXISTS / DO NOTHING.
-- ============================================================

-- ── karate_brackets ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS karate_brackets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id   UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  category_id      UUID NOT NULL REFERENCES karate_competition_categories(id) ON DELETE CASCADE,
  modality         TEXT NOT NULL CHECK (modality IN ('kumite','kata','kihon_ippon','team_kata','team_kumite')),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked')),
  -- seeded RNG seed (string so we can pass anything from frontend)
  draw_seed        TEXT,
  -- options snapshot at draw time
  options          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by       UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, category_id)
);

-- ── karate_bracket_matches ─────────────────────────────────────
-- Represents one match slot in the elimination tree.
-- round=0 is the first round; slot is the position within the round.
-- bracket_kind: 'main' = main bracket, 'third' = 3rd place match
CREATE TABLE IF NOT EXISTS karate_bracket_matches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bracket_id       UUID NOT NULL REFERENCES karate_brackets(id) ON DELETE CASCADE,
  round            INT  NOT NULL,  -- 0-indexed; 0 = first round
  slot             INT  NOT NULL,  -- 0-indexed within the round
  bracket_kind     TEXT NOT NULL DEFAULT 'main' CHECK (bracket_kind IN ('main','third')),
  -- entry_ids reference karate_competition_entries
  aka_entry_id     UUID REFERENCES karate_competition_entries(id) ON DELETE SET NULL,
  shiro_entry_id   UUID REFERENCES karate_competition_entries(id) ON DELETE SET NULL,
  winner_entry_id  UUID REFERENCES karate_competition_entries(id) ON DELETE SET NULL,
  is_bye           BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bracket_id, bracket_kind, round, slot)
);

-- ── karate_kata_scores ─────────────────────────────────────────
-- Stores per-athlete scores for kata events (eliminatória + final).
-- phase: 'eliminatoria' | 'final'
CREATE TABLE IF NOT EXISTS karate_kata_scores (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bracket_id       UUID NOT NULL REFERENCES karate_brackets(id) ON DELETE CASCADE,
  entry_id         UUID NOT NULL REFERENCES karate_competition_entries(id) ON DELETE CASCADE,
  phase            TEXT NOT NULL CHECK (phase IN ('eliminatoria','final')),
  nota             NUMERIC(5,2),   -- trimmed mean score (3 of 5 judges)
  presentation_order INT,          -- sorteio order
  advances         BOOLEAN,        -- TRUE once bracket locked/final computed
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bracket_id, entry_id, phase)
);

-- ── indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_brackets_competition ON karate_brackets(competition_id);
CREATE INDEX IF NOT EXISTS idx_bracket_matches_bracket ON karate_bracket_matches(bracket_id);
CREATE INDEX IF NOT EXISTS idx_kata_scores_bracket ON karate_kata_scores(bracket_id);
