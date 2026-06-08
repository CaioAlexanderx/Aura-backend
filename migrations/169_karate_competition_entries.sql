-- ============================================================
-- AURA KARATÊ — Migration 169: Inscrições + Ranking (Track E)
-- karate_competition_entries + VIEW karate_competition_ranking_season.
-- Aplicada no Supabase hawtujkztrjpvvkihowb.
--
-- DECISÃO DE ARQUITETURA — ranking é VIEW, não tabela materializada:
--   O plano previa karate_rankings (tabela denormalizada) + view materializada.
--   Optamos por uma VIEW comum agregando direto das inscrições com resultado.
--   Motivos: (1) sempre fresca após lançar resultado (o ranking embeddável
--   público precisa refletir em tempo real, §3.6); (2) zero risco de
--   dessincronização (princípio "fonte única" do projeto); (3) sem custo de
--   REFRESH agendado num backend Railway sem cron dedicado.
--   Pontuação fica em karate_competition_entries.points_awarded (lançada no
--   resultado). A view soma por temporada + categoria + atleta.
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_competition_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competition_id UUID NOT NULL REFERENCES karate_competitions(id) ON DELETE CASCADE,
  category_id    UUID NOT NULL REFERENCES karate_competition_categories(id) ON DELETE CASCADE,
  student_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dojo_id        UUID REFERENCES companies(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'registered'
                   CHECK (status IN ('registered','confirmed','checked_in','competing','done','withdrawn')),
  fee_paid       BOOLEAN NOT NULL DEFAULT false,
  placement      INT,
  points_awarded INT NOT NULL DEFAULT 0,
  result_notes   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_karate_comp_entries_competition
  ON karate_competition_entries(competition_id);
CREATE INDEX IF NOT EXISTS idx_karate_comp_entries_category
  ON karate_competition_entries(category_id, status);
CREATE INDEX IF NOT EXISTS idx_karate_comp_entries_student
  ON karate_competition_entries(student_id);

DROP TRIGGER IF EXISTS trg_karate_comp_entries_updated_at ON karate_competition_entries;
CREATE TRIGGER trg_karate_comp_entries_updated_at BEFORE UPDATE ON karate_competition_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE karate_competition_entries ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE VIEW karate_competition_ranking_season AS
SELECT
  c.federation_id,
  c.season,
  cat.name                                   AS category,
  e.student_id,
  cu.name                                    AS student_name,
  cu.karate_registration_number,
  cu.dojo_id,
  COALESCE(dj.trade_name, dj.legal_name)     AS dojo_name,
  SUM(COALESCE(e.points_awarded, 0))::int    AS total_points,
  COUNT(*) FILTER (WHERE e.placement = 1)::int AS gold,
  COUNT(*) FILTER (WHERE e.placement = 2)::int AS silver,
  COUNT(*) FILTER (WHERE e.placement = 3)::int AS bronze,
  COUNT(DISTINCT e.competition_id)::int       AS events_participated
FROM karate_competition_entries e
JOIN karate_competitions c            ON c.id = e.competition_id
JOIN karate_competition_categories cat ON cat.id = e.category_id
JOIN customers cu                     ON cu.id = e.student_id
LEFT JOIN companies dj                ON dj.id = cu.dojo_id
WHERE e.placement IS NOT NULL OR e.points_awarded > 0
GROUP BY c.federation_id, c.season, cat.name, e.student_id, cu.name,
         cu.karate_registration_number, cu.dojo_id, dj.trade_name, dj.legal_name;

-- FIM DA MIGRATION 169
