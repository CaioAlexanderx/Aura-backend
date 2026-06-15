-- ============================================================
-- AURA KARATÊ — Migration 181: Chaves / Brackets (Track M)
--
-- Tabelas:
--   karate_brackets        — chave por categoria (kumite/kata)
--   karate_bracket_matches — partidas do bracket eliminatório
--   karate_kata_scores     — notas de kata (por bateria)
--
-- DDL idempotente (IF NOT EXISTS / CREATE OR REPLACE).
-- Defensive try/catch no backend contra 42P01.
-- ============================================================

-- ── karate_brackets ─────────────────────────────────────────────
-- Uma chave por (competition_id, category_id).
CREATE TABLE IF NOT EXISTS karate_brackets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  competition_id  UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  category_id     UUID NOT NULL REFERENCES karate_competition_categories(id) ON DELETE CASCADE,

  -- modality snapshot (evita JOIN na leitura)
  modality        TEXT NOT NULL CHECK (modality IN ('kata','kumite','kihon_ippon','team_kata','team_kumite')),

  -- draft = sorteio não travado (pode regenerar)
  -- locked = oficial; libera lançamento de resultados
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked')),

  -- Semente do sorteio (string; armazenada para reprodutibilidade)
  draw_seed       TEXT,

  -- Opções do sorteio: { method, separateSameDojo, thirdPlace, ... }
  options         JSONB NOT NULL DEFAULT '{}',

  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Uma chave por categoria por competição
  CONSTRAINT uq_bracket_per_category UNIQUE (competition_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_karate_brackets_comp
  ON karate_brackets(competition_id);

CREATE INDEX IF NOT EXISTS idx_karate_brackets_cat
  ON karate_brackets(category_id);

-- ── karate_bracket_matches ───────────────────────────────────────
-- Partidas do bracket (kumite: todas as rodadas; kata: não usa esta tabela).
-- round 0 = primeira rodada, round N-1 = final.
-- bracket_kind 'main' = chave principal, 'third' = disputa de 3º lugar.
CREATE TABLE IF NOT EXISTS karate_bracket_matches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  bracket_id      UUID NOT NULL REFERENCES karate_brackets(id) ON DELETE CASCADE,

  round           INT NOT NULL,
  slot            INT NOT NULL,

  -- 'main' para chave principal, 'third' para disputa de 3º lugar
  bracket_kind    TEXT NOT NULL DEFAULT 'main' CHECK (bracket_kind IN ('main','third')),

  -- Inscrições dos competidores (NULL = ainda não definido / aguarda rodada anterior)
  -- NULL também aparece quando o slot é bye
  aka_entry_id    UUID REFERENCES karate_competition_entries(id) ON DELETE SET NULL,
  shiro_entry_id  UUID REFERENCES karate_competition_entries(id) ON DELETE SET NULL,

  -- Vencedor (NULL enquanto não lançado)
  winner_entry_id UUID REFERENCES karate_competition_entries(id) ON DELETE SET NULL,

  -- true quando um dos lados é bye (vitória automática)
  is_bye          BOOLEAN NOT NULL DEFAULT FALSE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bracket_matches_bracket
  ON karate_bracket_matches(bracket_id, round, slot);

CREATE INDEX IF NOT EXISTS idx_bracket_matches_entries
  ON karate_bracket_matches(aka_entry_id, shiro_entry_id);

-- ── karate_kata_scores ───────────────────────────────────────────
-- Notas de kata por atleta por fase (eliminatoria / final).
-- 5 jurados: descarta maior e menor; nota final = soma dos 3 do meio.
-- Esta tabela armazena a nota composta já calculada (UI faz o cálculo
-- ou pode vir do árbitro — simplificação acordada).
CREATE TABLE IF NOT EXISTS karate_kata_scores (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  bracket_id           UUID NOT NULL REFERENCES karate_brackets(id) ON DELETE CASCADE,
  entry_id             UUID NOT NULL REFERENCES karate_competition_entries(id) ON DELETE CASCADE,

  -- 'eliminatoria' ou 'final'
  phase                TEXT NOT NULL CHECK (phase IN ('eliminatoria','final')),

  -- Nota composta (soma dos 3 jurados do meio, após descartar maior+menor)
  -- NULL = ainda não lançada
  nota                 NUMERIC(5,2) CHECK (nota IS NULL OR (nota >= 0 AND nota <= 30)),

  -- Ordem de apresentação (sorteada pelo /generate-order)
  presentation_order   INT,

  -- true = atleta avançou para a próxima fase
  advances             BOOLEAN,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_kata_score_entry_phase UNIQUE (bracket_id, entry_id, phase)
);

CREATE INDEX IF NOT EXISTS idx_kata_scores_bracket
  ON karate_kata_scores(bracket_id, phase, nota DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_kata_scores_entry
  ON karate_kata_scores(entry_id);

-- ── updated_at trigger (helper compartilhado) ────────────────────
-- Reutiliza a função se já existir (idempotente via CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_karate_brackets_updated_at ON karate_brackets;
CREATE TRIGGER trg_karate_brackets_updated_at
  BEFORE UPDATE ON karate_brackets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_karate_bracket_matches_updated_at ON karate_bracket_matches;
CREATE TRIGGER trg_karate_bracket_matches_updated_at
  BEFORE UPDATE ON karate_bracket_matches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_karate_kata_scores_updated_at ON karate_kata_scores;
CREATE TRIGGER trg_karate_kata_scores_updated_at
  BEFORE UPDATE ON karate_kata_scores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- FIM DA MIGRATION 181
-- ============================================================
