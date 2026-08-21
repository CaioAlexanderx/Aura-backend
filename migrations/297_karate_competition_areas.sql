-- ============================================================
-- AURA KARATÊ — Migration 297: P1 do Hub — KOTOS (áreas de competição)
-- e ORDEM DO DIA (Dossiê Shiai §6)
--
-- O QUE OS DOCUMENTOS REAIS MOSTRAM (distribuições de kotos JKA/FPKT):
--   • O evento roda em 4-5 áreas simultâneas ("Koto A".."Koto E");
--   • Cada categoria é ALOCADA a um koto, numa ORDEM (crianças primeiro),
--     com contagem de atletas e estimativa de horas por área para
--     balancear o dia ("(3,5H) 58 atletas");
--   • O mesmo atleta pode competir em kotos diferentes (kata individual
--     num, equipe noutro) — a alocação é POR CATEGORIA.
--
-- O QUE ESTA MIGRATION ADICIONA (aditiva e idempotente):
--   1) karate_competition_areas — os kotos do evento;
--   2) karate_competition_categories.area_id + area_order — a alocação e
--      a posição na ordem do dia daquele koto.
--
-- A estimativa de carga (minutos por categoria) é HEURÍSTICA de código
-- (karateScheduleService, puro) — não é persistida: recalcula sempre do
-- entry_count vivo, como a planilha real fazia à mão.
-- Aplicar via Supabase MCP antes do merge.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_competition_areas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,               -- "Koto A", "Área 1"...
  sort_order     INT  NOT NULL DEFAULT 0,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, name)
);
CREATE INDEX IF NOT EXISTS idx_kca_competition
  ON karate_competition_areas(competition_id, sort_order);

DROP TRIGGER IF EXISTS trg_kca_updated_at ON karate_competition_areas;
CREATE TRIGGER trg_kca_updated_at BEFORE UPDATE ON karate_competition_areas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_competition_areas ENABLE ROW LEVEL SECURITY;

ALTER TABLE karate_competition_categories
  ADD COLUMN IF NOT EXISTS area_id UUID REFERENCES karate_competition_areas(id) ON DELETE SET NULL;
ALTER TABLE karate_competition_categories
  ADD COLUMN IF NOT EXISTS area_order INT;

CREATE INDEX IF NOT EXISTS idx_kcc_area
  ON karate_competition_categories(area_id, area_order);

COMMENT ON COLUMN karate_competition_categories.area_id IS
  'Koto (área de competição) onde a categoria roda. NULL = ainda não alocada ao dia.';
COMMENT ON COLUMN karate_competition_categories.area_order IS
  'Posição da categoria na ordem do dia do koto (crianças primeiro é convenção, não regra do banco).';

-- ============================================================
-- FIM DA MIGRATION 297
-- ============================================================
