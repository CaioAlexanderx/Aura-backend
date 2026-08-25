-- ============================================================
-- AURA KARATÊ — quantos ÁRBITROS dão nota (kata/enbu)
--
-- A mesa desenhava 5 campos de nota sempre. Na prática o número varia:
-- categorias de base costumam rodar com 3 árbitros e finais grandes com
-- 7. O motor de apuração (karateKataScoring) já aceita 3..7 — faltava
-- alguém dizer QUANTOS são.
--
-- Hierarquia: a competição define o padrão; a categoria pode
-- sobrescrever (NULL = herda a competição). Efetivo =
-- COALESCE(categoria, competição, 5).
--
-- O lançamento de notas NÃO passa a exigir exatamente judge_count: o
-- número guia quantos campos a mesa desenha, mas uma categoria que rodou
-- com um árbitro a menos continua sendo lançável. Trava de config não
-- pode parar a competição.
-- ============================================================

ALTER TABLE karate_competitions
  ADD COLUMN IF NOT EXISTS judge_count SMALLINT
    CHECK (judge_count IS NULL OR judge_count BETWEEN 3 AND 7);

ALTER TABLE karate_competition_categories
  ADD COLUMN IF NOT EXISTS judge_count SMALLINT
    CHECK (judge_count IS NULL OR judge_count BETWEEN 3 AND 7);

COMMENT ON COLUMN karate_competitions.judge_count IS
  'Árbitros que dão nota em kata/enbu (3..7). NULL = 5 (padrão FPKT/JKA).';
COMMENT ON COLUMN karate_competition_categories.judge_count IS
  'Override do número de árbitros desta categoria. NULL = herda a competição.';
