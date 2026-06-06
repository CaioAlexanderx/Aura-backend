-- ============================================================
-- AURA KARATÊ — Migration 150: Critérios de graduação
-- Tabela configurável por federação — cada federação define
-- seus próprios requisitos para promoção entre faixas.
-- Seed com critérios padrão FPKT para belt_schema='fpkt_shotokan'
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_belt_requirements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Qual federação define este critério
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- De qual faixa (nível atual do praticante)
  from_belt       TEXT NOT NULL,

  -- Para qual faixa (graduação pretendida)
  to_belt         TEXT NOT NULL,

  -- Em qual schema este critério se aplica
  belt_schema     TEXT NOT NULL DEFAULT 'fpkt_shotokan'
                  CHECK (belt_schema IN ('legacy', 'fpkt_shotokan')),

  -- Tempo mínimo na faixa atual (em meses)
  min_months      INT NOT NULL DEFAULT 0,

  -- Katas obrigatórios (array de nomes)
  required_kata   TEXT[] DEFAULT '{}',

  -- Tipo de kumite exigido (ex: 'Kihon-Ippon', 'Gohon Kumite', 'Jiyu Kumite')
  required_kumite TEXT,

  -- Quantidade mínima de cursos/seminários oficiais
  min_courses     INT NOT NULL DEFAULT 0,

  -- Observações e exigências adicionais
  notes           TEXT,

  -- Se falso, critério é informativo (soft warning) e não bloqueia inscrição
  is_hard_block   BOOLEAN NOT NULL DEFAULT true,

  -- Ativo/inativo (permite desativar sem deletar)
  is_active       BOOLEAN NOT NULL DEFAULT true,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Um critério único por par (from→to) dentro da federação e schema
  UNIQUE (federation_id, from_belt, to_belt, belt_schema)
);

CREATE TRIGGER trg_belt_req_updated_at
  BEFORE UPDATE ON karate_belt_requirements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_belt_req_federation
  ON karate_belt_requirements(federation_id, belt_schema, is_active);

-- ============================================================
-- SEED: Critérios padrão FPKT — Sistema fpkt_shotokan
-- Serão associados à FPKT após o setup da empresa federação.
-- Esta função é chamada pelo backend no POST /karate/federation/setup.
-- Aqui definimos a função; ela é chamada após criação da empresa.
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
     'Exame estadual obrigatório com banca designada pela FPKT.'),

    -- Shodan → Nidan
    (p_federation_id, '1dan', '2dan', 'fpkt_shotokan', 24,
     ARRAY['Bassai-Sho', 'Kanku-Sho'], 'Jiyu Kumite', 2,
     '2 cursos oficiais. Banca FPKT.'),

    -- Nidan → Sandan
    (p_federation_id, '2dan', '3dan', 'fpkt_shotokan', 36,
     ARRAY['Sochin', 'Nijushiho'], 'Jiyu Kumite', 3,
     '3 cursos + experiência de arbitragem.')

  ON CONFLICT (federation_id, from_belt, to_belt, belt_schema) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- FIM DA MIGRATION 150
-- ============================================================
