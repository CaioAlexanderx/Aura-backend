-- ============================================================
-- AURA KARATÊ — Migration 149: Histórico de faixas
-- Tabela append-only e imutável — nunca permite UPDATE ou DELETE
-- Suporta dual-schema: sistema legado (7 kyus) e atual (10 kyus)
-- ============================================================

CREATE TABLE IF NOT EXISTS karate_belt_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Quem graduou
  student_id      UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Qual federação emitiu (para suporte multi-federação futuro)
  federation_id   UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Graduação obtida
  -- belt_level: código canônico ex: '10kyu', '9kyu', '1dan', '3dan'
  belt_level      TEXT NOT NULL,

  -- belt_name: nome da cor exata no momento do registro
  -- Exemplos: 'Branca', 'Amarela', 'Vermelha', 'Azul Claro', 'Preta'
  belt_name       TEXT NOT NULL,

  -- Schema em vigor no momento do registro
  -- 'legacy'         → sistema antigo (7 kyus, inclui Vermelha/4ºKyu)
  -- 'fpkt_shotokan'  → sistema atual FPKT (10 kyus, sem Vermelha)
  belt_schema     TEXT NOT NULL DEFAULT 'fpkt_shotokan'
                  CHECK (belt_schema IN ('legacy', 'fpkt_shotokan')),

  -- Data da graduação (pode ser retroativa para import histórico)
  graduated_at    DATE NOT NULL,

  -- Banca examinadora (nullable para imports históricos sem banca registrada)
  examiner_1_id   UUID REFERENCES customers(id) ON DELETE SET NULL,
  examiner_2_id   UUID REFERENCES customers(id) ON DELETE SET NULL,

  -- FK para o exame oficial (nullable: imports históricos não têm exame)
  -- exam_id será populado após migration 153 (karate_belt_exams)
  exam_id         UUID,

  -- Observações da banca ou contexto do import
  notes           TEXT,

  -- Metadados de auditoria
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()

  -- NÃO tem updated_at: esta tabela é append-only e imutável
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_belt_history_student
  ON karate_belt_history(student_id, graduated_at DESC);

CREATE INDEX IF NOT EXISTS idx_belt_history_federation
  ON karate_belt_history(federation_id, graduated_at DESC);

CREATE INDEX IF NOT EXISTS idx_belt_history_schema
  ON karate_belt_history(belt_schema);

-- View auxiliar: faixa atual de cada praticante
-- (MAX(graduated_at) por praticante e federação)
CREATE OR REPLACE VIEW karate_current_belt AS
SELECT DISTINCT ON (student_id, federation_id)
  student_id,
  federation_id,
  belt_level,
  belt_name,
  belt_schema,
  graduated_at AS current_since,
  exam_id
FROM karate_belt_history
ORDER BY student_id, federation_id, graduated_at DESC;

-- ============================================================
-- TRIGGER DE IMUTABILIDADE
-- Impede qualquer UPDATE ou DELETE nesta tabela
-- O histórico de faixas é imutável por design e por contrato
-- ============================================================

CREATE OR REPLACE FUNCTION karate_belt_history_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'karate_belt_history é append-only e imutável. '
    'Use INSERT para adicionar novos registros. '
    'Contate o administrador para correções excepcionais.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_belt_history_no_update
  BEFORE UPDATE ON karate_belt_history
  FOR EACH ROW EXECUTE FUNCTION karate_belt_history_immutable();

CREATE TRIGGER trg_belt_history_no_delete
  BEFORE DELETE ON karate_belt_history
  FOR EACH ROW EXECUTE FUNCTION karate_belt_history_immutable();

-- ============================================================
-- FIM DA MIGRATION 149
-- ============================================================
