-- ============================================================
-- AURA KARATÊ — Migration 301: fundação P2 do Hub (modo mesário)
-- ------------------------------------------------------------
-- Lapidação pós-Campeonato Paulista 2026 (vivência de campo 22/08):
-- a maior dor foi o "correio de papel" dos resultados (mesa → mesa
-- central → premiação) e mesários inexperientes tendo que decorar o
-- regulamento (formatos que mudam por fase e por divisão).
--
-- (a) modality ganha 'enbu' (duplas, janela de tempo + notas) e 'fukugo'
--     (kata Kittei + shobu-ippon) — modalidades REAIS do Paulista/FPKT
--     que o CHECK da 168 não previa.
-- (b) karate_competitions.results_config jsonb — pontuação por colocação
--     p/ o ranking da temporada (ex.: {"points_by_placement":
--     {"1":9,"2":6,"3":3}}). O finalize da chave usa isto para gravar
--     points_awarded automaticamente; sem config, só placement (o atleta
--     aparece no ranking por medalha, sem pontos).
-- (c) karate_competition_categories.awards_delivered_at — a fila de
--     premiação ao vivo marca a categoria como "medalhas entregues"
--     (mata a planilha andando até a mesa de premiação).
--
-- Idempotente: DROP CONSTRAINT IF EXISTS + ADD; ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE karate_competition_categories
  DROP CONSTRAINT IF EXISTS karate_competition_categories_modality_check;

ALTER TABLE karate_competition_categories
  ADD CONSTRAINT karate_competition_categories_modality_check
  CHECK (modality IN ('kata','kumite','kihon_ippon','team_kata','team_kumite','enbu','fukugo'));

ALTER TABLE karate_competitions
  ADD COLUMN IF NOT EXISTS results_config JSONB;

ALTER TABLE karate_competition_categories
  ADD COLUMN IF NOT EXISTS awards_delivered_at TIMESTAMPTZ;

-- ============================================================
-- FIM DA MIGRATION 301
-- ============================================================
