-- ============================================================
-- AURA. — Migration 049: Periograma + Fichas de especialidade
--
-- Aplicada em producao via MCP Supabase em 24/04/2026.
-- Arquivo espelho criado conforme regra de migration da sessao
-- (toda apply_migration via MCP DEVE ter .sql no repo pra CI).
--
-- Fase 3 do W1-01: persistencia de Periograma e Fichas por
-- paciente, fechando as 2 ultimas sub-tabs do PatientHub
-- (antes apenas renderizavam componente base sem save).
-- ============================================================

-- ── dental_perio_exams ──
CREATE TABLE IF NOT EXISTS dental_perio_exams (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     uuid         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  exam_date       date         NOT NULL DEFAULT CURRENT_DATE,
  measurements    jsonb        NOT NULL DEFAULT '{}'::jsonb,
  bleeding_sites  int          NOT NULL DEFAULT 0 CHECK (bleeding_sites >= 0),
  total_sites     int          NOT NULL DEFAULT 0 CHECK (total_sites >= 0),
  bleeding_index  int          NOT NULL DEFAULT 0 CHECK (bleeding_index BETWEEN 0 AND 100),
  plaque_index    int          NOT NULL DEFAULT 0 CHECK (plaque_index BETWEEN 0 AND 100),
  diagnosis       text,
  notes           text,
  created_by      uuid,
  created_at      timestamptz  NOT NULL DEFAULT NOW(),
  updated_at      timestamptz  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dental_perio_customer_date
  ON dental_perio_exams(customer_id, exam_date DESC);
CREATE INDEX IF NOT EXISTS idx_dental_perio_company
  ON dental_perio_exams(company_id);

COMMENT ON TABLE  dental_perio_exams IS
  'Exames periodontais. Um paciente pode ter varios exames ao longo do tempo (acompanhamento).';
COMMENT ON COLUMN dental_perio_exams.measurements IS
  'JSONB com medicoes por dente: { "tooth_11": { buccal: [3,2,3], lingual: [2,3,2], recession: [0,0,0], mobility: 0, furcation: 0, bleeding: [false,true,false] }, ... }';
COMMENT ON COLUMN dental_perio_exams.bleeding_index IS
  'Indice de sangramento (BoP) em percentual 0-100. >20% indica doenca periodontal ativa.';
COMMENT ON COLUMN dental_perio_exams.plaque_index IS
  'Indice de placa (PI) em percentual 0-100. >30% indica higiene inadequada.';

-- ── dental_specialty_forms ──
CREATE TABLE IF NOT EXISTS dental_specialty_forms (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     uuid         NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  specialty       varchar(30)  NOT NULL,
  form_data       jsonb        NOT NULL DEFAULT '{}'::jsonb,
  professional_id uuid         REFERENCES dental_practitioners(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid,
  created_at      timestamptz  NOT NULL DEFAULT NOW(),
  updated_at      timestamptz  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_specialty_values CHECK (
    specialty IN ('ortodontia','endodontia','periodontia','cirurgia','implante','protese')
  )
);

CREATE INDEX IF NOT EXISTS idx_dental_specialty_customer
  ON dental_specialty_forms(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_specialty_company_spec
  ON dental_specialty_forms(company_id, specialty);

COMMENT ON TABLE  dental_specialty_forms IS
  'Fichas clinicas especificas por especialidade. Estrutura flexivel via JSONB (form_data).';
COMMENT ON COLUMN dental_specialty_forms.specialty IS
  'Uma das 6 especialidades suportadas: ortodontia, endodontia, periodontia, cirurgia, implante, protese.';
COMMENT ON COLUMN dental_specialty_forms.form_data IS
  'Campos do form como chave-valor. Estrutura varia por specialty (ex ortodontia: classificacao_angle, overjet, overbite...).';
