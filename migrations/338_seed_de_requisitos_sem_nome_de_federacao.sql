-- ============================================================
-- 338 — O seed de requisitos para de nomear a FPKT
--
-- POR QUE: karate_seed_fpkt_requirements(uuid) roda no POST
-- /karate/federation/setup de QUALQUER federação (migration 150). Duas das
-- notas que ela grava nomeiam a FPKT:
--
--   1kyu → 1dan : "Exame estadual obrigatório com banca designada pela FPKT."
--   1dan → 2dan : "2 cursos oficiais. Banca FPKT."
--
-- Essas notas aparecem na tabela de requisitos que o SENSEI lê. A JKA Teste
-- (criada em 16/09/2026) nasceu com as duas — a federação errada dizendo ao
-- dojô dela quem convoca a banca. Mesmo defeito do prefixo de filiação
-- (migration 337), só que em texto e não em código.
--
-- O QUE MUDA: só as duas notas. Meses mínimos, katas, kumite e número de
-- cursos ficam idênticos — o corpo da função foi copiado da 150 sem
-- reescrita. O NOME da função não muda: é identificador (o backend chama por
-- ele e a 151 faz ALTER FUNCTION nele), não texto.
--
-- 'fpkt_shotokan' em belt_schema também NÃO muda: é o VALOR que separa a
-- escala atual (10 kyus) da 'legacy' (7 kyus) e está gravado em
-- karate_belt_history de todo mundo. Renomear quebraria o histórico.
--
-- Idempotente: CREATE OR REPLACE + UPDATE que só acha linha com o texto
-- antigo (a segunda execução não encontra nenhuma).
-- ============================================================

CREATE OR REPLACE FUNCTION karate_seed_fpkt_requirements(p_federation_id UUID)
RETURNS VOID AS $$
BEGIN
  INSERT INTO karate_belt_requirements
    (federation_id, from_belt, to_belt, belt_schema, min_months, required_kata, required_kumite, min_courses, notes)
  VALUES
    -- Branca → Amarela
    (p_federation_id, '10kyu', '9kyu', 'fpkt_shotokan', 3,
     ARRAY['Taikyoku Shodan'], NULL, 0,
     'Primeiro exame. Postura básica e kihon.'),

    -- Amarela → Laranja
    (p_federation_id, '9kyu', '8kyu', 'fpkt_shotokan', 4,
     ARRAY['Heian Shodan'], 'Kihon-Ippon', 0,
     NULL),

    -- Laranja → Verde
    (p_federation_id, '8kyu', '7kyu', 'fpkt_shotokan', 6,
     ARRAY['Heian Nidan'], 'Kihon-Ippon', 0,
     NULL),

    -- Verde → Azul Claro
    (p_federation_id, '7kyu', '6kyu', 'fpkt_shotokan', 6,
     ARRAY['Heian Sandan'], 'Kihon-Ippon', 0,
     NULL),

    -- Azul Claro → Roxo
    (p_federation_id, '6kyu', '5kyu', 'fpkt_shotokan', 8,
     ARRAY['Heian Yondan'], 'Gohon Kumite', 0,
     NULL),

    -- Roxo → Azul Escuro
    (p_federation_id, '5kyu', '4kyu', 'fpkt_shotokan', 8,
     ARRAY['Heian Godan'], 'Gohon Kumite', 0,
     NULL),

    -- Azul Escuro → Marrom 3º Kyu
    (p_federation_id, '4kyu', '3kyu', 'fpkt_shotokan', 12,
     ARRAY['Tekki Shodan'], 'Jiyu-Ippon', 1,
     'Mínimo 1 curso oficial por ano.'),

    -- Marrom 3º → Marrom 2º
    (p_federation_id, '3kyu', '2kyu', 'fpkt_shotokan', 12,
     ARRAY['Bassai-Dai'], 'Jiyu-Ippon', 1,
     NULL),

    -- Marrom 2º → Marrom 1º
    (p_federation_id, '2kyu', '1kyu', 'fpkt_shotokan', 18,
     ARRAY['Bassai-Dai', 'Kanku-Dai'], 'Jiyu-Ippon', 1,
     NULL),

    -- Marrom 1º → Shodan (1º Dan)
    (p_federation_id, '1kyu', '1dan', 'fpkt_shotokan', 24,
     ARRAY['Kanku-Dai', 'Jion', 'Enpi'], 'Jiyu Kumite', 1,
     'Exame estadual obrigatório com banca designada pela federação.'),

    -- Shodan → Nidan
    (p_federation_id, '1dan', '2dan', 'fpkt_shotokan', 24,
     ARRAY['Bassai-Sho', 'Kanku-Sho'], 'Jiyu Kumite', 2,
     '2 cursos oficiais. Banca da federação.'),

    -- Nidan → Sandan
    (p_federation_id, '2dan', '3dan', 'fpkt_shotokan', 36,
     ARRAY['Sochin', 'Nijushiho'], 'Jiyu Kumite', 3,
     '3 cursos + experiência de arbitragem.')

  ON CONFLICT (federation_id, from_belt, to_belt, belt_schema) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- Federações já semeadas (inclusive a incumbente): a nota passa a valer para
-- qualquer uma. Casa pelo texto exato que a 150 gravou — nota editada à mão
-- pela federação não é tocada.
UPDATE karate_belt_requirements
   SET notes = 'Exame estadual obrigatório com banca designada pela federação.'
 WHERE notes = 'Exame estadual obrigatório com banca designada pela FPKT.';

UPDATE karate_belt_requirements
   SET notes = '2 cursos oficiais. Banca da federação.'
 WHERE notes = '2 cursos oficiais. Banca FPKT.';
