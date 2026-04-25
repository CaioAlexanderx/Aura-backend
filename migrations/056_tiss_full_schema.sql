-- ============================================================
-- AURA. — W2-02 F1: Schema TISS 4.01 completo
--
-- Expansao do schema existente (S11 D-16/D-17) pra suportar:
-- - 4 tipos de guia: consulta, sp_sadt, honorario, internacao
-- - Dados ANS completos da operadora
-- - Carteirinha do paciente (cod + validade + plano)
-- - Lotes (faturamento mensal agrupado)
-- - Demonstrativo de pagamento (parser de retorno)
-- - Codigos de glosa
-- ============================================================

-- ── 1. dental_insurance: dados ANS completos ──────────────
ALTER TABLE dental_insurance
  ADD COLUMN IF NOT EXISTS cnpj                 varchar(20),
  ADD COLUMN IF NOT EXISTS razao_social         varchar(200),
  ADD COLUMN IF NOT EXISTS contract_number      varchar(80),
  ADD COLUMN IF NOT EXISTS contract_start       date,
  ADD COLUMN IF NOT EXISTS contract_end         date,
  ADD COLUMN IF NOT EXISTS tiss_version         varchar(10) NOT NULL DEFAULT '4.01.00',
  ADD COLUMN IF NOT EXISTS provider_code        varchar(40),
  ADD COLUMN IF NOT EXISTS provider_code_type   varchar(20) DEFAULT 'cnpj',
  ADD COLUMN IF NOT EXISTS reference_table_id   varchar(10) DEFAULT '22',
  ADD COLUMN IF NOT EXISTS xml_namespace        varchar(200),
  ADD COLUMN IF NOT EXISTS upload_portal_url    varchar(400),
  ADD COLUMN IF NOT EXISTS notes_billing        text;

COMMENT ON COLUMN dental_insurance.tiss_version IS 'Versao TISS aceita pelo convenio. Default 4.01.00 (vigente desde 2024).';
COMMENT ON COLUMN dental_insurance.provider_code IS 'Codigo do prestador (clinica) na operadora. Geralmente o CNPJ, mas pode ser codigo proprio.';
COMMENT ON COLUMN dental_insurance.upload_portal_url IS 'URL do portal pra upload manual do XML.';

-- ── 2. dental_patient_insurance: carteirinhas ────────────
CREATE TABLE IF NOT EXISTS dental_patient_insurance (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id     uuid        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  insurance_id    uuid        NOT NULL REFERENCES dental_insurance(id) ON DELETE CASCADE,
  card_number     varchar(40) NOT NULL,
  plan_name       varchar(120),
  plan_code       varchar(40),
  card_valid_until date,
  holder_name     varchar(200),
  holder_cpf      varchar(20),
  is_primary      boolean     NOT NULL DEFAULT true,
  is_active       boolean     NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, customer_id, insurance_id, card_number)
);
CREATE INDEX IF NOT EXISTS idx_dental_patient_insurance_customer
  ON dental_patient_insurance(customer_id, is_active);
CREATE INDEX IF NOT EXISTS idx_dental_patient_insurance_company
  ON dental_patient_insurance(company_id);

COMMENT ON TABLE dental_patient_insurance IS
  'Carteirinhas do paciente. Um paciente pode ter varios convenios. is_primary marca a default ao gerar guia.';

-- ── 3. dental_tiss_guides: campos completos pra 4 tipos de guia ──
ALTER TABLE dental_tiss_guides
  ADD COLUMN IF NOT EXISTS patient_insurance_id uuid REFERENCES dental_patient_insurance(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS card_number          varchar(40),
  ADD COLUMN IF NOT EXISTS card_valid_until     date,
  ADD COLUMN IF NOT EXISTS holder_name          varchar(200),
  ADD COLUMN IF NOT EXISTS auth_password        varchar(40),
  ADD COLUMN IF NOT EXISTS auth_number          varchar(40),
  ADD COLUMN IF NOT EXISTS auth_validity        date,
  ADD COLUMN IF NOT EXISTS service_date         date,
  ADD COLUMN IF NOT EXISTS service_start_time   time,
  ADD COLUMN IF NOT EXISTS service_end_time     time,
  ADD COLUMN IF NOT EXISTS service_type         varchar(20),
  ADD COLUMN IF NOT EXISTS attendance_type      varchar(20),
  ADD COLUMN IF NOT EXISTS accident_indication  varchar(20),
  ADD COLUMN IF NOT EXISTS professional_council varchar(10) DEFAULT 'CRO',
  ADD COLUMN IF NOT EXISTS professional_council_uf varchar(2),
  ADD COLUMN IF NOT EXISTS professional_cbo     varchar(10),
  ADD COLUMN IF NOT EXISTS hospital_admission_at  timestamptz,
  ADD COLUMN IF NOT EXISTS hospital_discharge_at  timestamptz,
  ADD COLUMN IF NOT EXISTS hospital_regime        varchar(20),
  ADD COLUMN IF NOT EXISTS clinical_indication    text,
  ADD COLUMN IF NOT EXISTS cid_code               varchar(10),
  ADD COLUMN IF NOT EXISTS batch_id             uuid,
  ADD COLUMN IF NOT EXISTS paid_value           numeric,
  ADD COLUMN IF NOT EXISTS paid_at              timestamptz,
  ADD COLUMN IF NOT EXISTS glossed_value        numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS glossed_codes        jsonb;

COMMENT ON COLUMN dental_tiss_guides.guide_type IS
  'Tipo de guia TISS: consulta | sp_sadt | honorario | internacao';
COMMENT ON COLUMN dental_tiss_guides.glossed_codes IS
  'Codigos de glosa retornados pela operadora. Cada item: {code, description, value}.';

-- ── 4. dental_tiss_batches: lote de faturamento ──────────
CREATE TABLE IF NOT EXISTS dental_tiss_batches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  insurance_id    uuid        NOT NULL REFERENCES dental_insurance(id) ON DELETE CASCADE,
  batch_number    varchar(40) NOT NULL,
  reference_month varchar(7)  NOT NULL,
  total_value     numeric     NOT NULL DEFAULT 0,
  guide_count     int         NOT NULL DEFAULT 0,
  status          varchar(30) NOT NULL DEFAULT 'rascunho',
  xml_content     text,
  xml_url         text,
  protocol_number varchar(80),
  sent_at         timestamptz,
  processed_at    timestamptz,
  total_paid      numeric DEFAULT 0,
  total_glossed   numeric DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, insurance_id, batch_number)
);
CREATE INDEX IF NOT EXISTS idx_dental_tiss_batches_company
  ON dental_tiss_batches(company_id, reference_month DESC);
CREATE INDEX IF NOT EXISTS idx_dental_tiss_batches_insurance
  ON dental_tiss_batches(insurance_id, status);

-- FK do batch (idempotente via DO block — PG nao suporta ADD CONSTRAINT IF NOT EXISTS)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_dental_tiss_guides_batch'
  ) THEN
    ALTER TABLE dental_tiss_guides
      ADD CONSTRAINT fk_dental_tiss_guides_batch
      FOREIGN KEY (batch_id) REFERENCES dental_tiss_batches(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON TABLE dental_tiss_batches IS
  'Lote de faturamento mensal. Agrupa varias guias do mesmo convenio pra envio unico.';

-- ── 5. dental_tiss_glosa_codes: codigos de glosa ANS ─────
CREATE TABLE IF NOT EXISTS dental_tiss_glosa_codes (
  code        varchar(10) PRIMARY KEY,
  description text        NOT NULL,
  category    varchar(40),
  is_active   boolean DEFAULT true
);

COMMENT ON TABLE dental_tiss_glosa_codes IS
  'Tabela 38 ANS — codigos padronizados de motivos de glosa. Seed na migration 057.';

-- ── 6. dental_tuss_codes: campos extras pro TUSS oficial ──
ALTER TABLE dental_tuss_codes
  ADD COLUMN IF NOT EXISTS table_origin       varchar(10) DEFAULT '22',
  ADD COLUMN IF NOT EXISTS porte              varchar(10),
  ADD COLUMN IF NOT EXISTS porte_anestesico   varchar(10),
  ADD COLUMN IF NOT EXISTS valor_custo_op     numeric,
  ADD COLUMN IF NOT EXISTS filme_radiologico  numeric,
  ADD COLUMN IF NOT EXISTS incidencia         int DEFAULT 1,
  ADD COLUMN IF NOT EXISTS company_id         uuid REFERENCES companies(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS created_at         timestamptz DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_dental_tuss_codes_active
  ON dental_tuss_codes(code) WHERE is_active = true;

-- Trigger updated_at em dental_patient_insurance
CREATE OR REPLACE FUNCTION update_dental_patient_insurance_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dental_patient_insurance_updated_at
  ON dental_patient_insurance;
CREATE TRIGGER trg_dental_patient_insurance_updated_at
  BEFORE UPDATE ON dental_patient_insurance
  FOR EACH ROW EXECUTE FUNCTION update_dental_patient_insurance_at();
