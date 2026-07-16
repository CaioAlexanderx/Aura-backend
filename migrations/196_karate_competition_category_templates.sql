-- ============================================================
-- AURA KARATÊ — Migration 196: Biblioteca de categorias reutilizáveis
-- karate_competition_category_templates.
-- Numeração real: segue 195_karate_practitioner_guardian (última karatê).
--
-- Permite à federação salvar categorias de campeonato como TEMPLATES
-- reutilizáveis, aplicáveis a qualquer competição. Espelha as colunas de
-- karate_competition_categories (sem o vínculo competition_id), + federation_id
-- + soft-delete (archived_at). Decisão Caio: o template guarda a definição
-- COMPLETA, incluindo taxa/vagas como padrão reutilizável.
--
-- Idempotente: IF NOT EXISTS em tudo. Aplicar via Supabase MCP antes do merge.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_competition_category_templates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  federation_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
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
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  archived_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_karate_cat_templates_federation
  ON karate_competition_category_templates(federation_id, archived_at);

DROP TRIGGER IF EXISTS trg_karate_cat_templates_updated_at ON karate_competition_category_templates;
CREATE TRIGGER trg_karate_cat_templates_updated_at BEFORE UPDATE ON karate_competition_category_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_competition_category_templates ENABLE ROW LEVEL SECURITY;

-- FIM DA MIGRATION 196
