-- 189_karate_current_belt_tiebreak.sql
-- Faixa atual: desempate por hierarquia de faixa quando graduated_at empata
-- (o import datou muitas faixas como 1900/1996 -> DISTINCT ON pegava arbitrário,
-- às vezes uma faixa MENOR). Adiciona belt_rank DESC ao ORDER BY.
-- Vermelha = 0 (histórica, nunca vence empate). Idempotente; já aplicada em prod.
CREATE OR REPLACE VIEW karate_current_belt AS
SELECT DISTINCT ON (student_id, federation_id)
  student_id, federation_id, belt_level, belt_name, belt_schema,
  graduated_at AS current_since, exam_id
FROM karate_belt_history
ORDER BY student_id, federation_id, graduated_at DESC,
  CASE lower(belt_level)
    WHEN 'branca' THEN 1 WHEN 'amarela' THEN 2 WHEN 'laranja' THEN 3
    WHEN 'verde' THEN 4 WHEN 'roxo' THEN 5 WHEN 'roxa' THEN 5
    WHEN 'marrom' THEN 6 WHEN 'preta' THEN 7
    WHEN 'vermelha' THEN 0 ELSE 0
  END DESC;
