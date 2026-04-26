-- ============================================================
-- AURA. — Migration 069: Sync customers → dental_patients (P2.1)
--
-- CONTEXTO: dental_patients ainda existe (em transicao desde 050)
-- com registros legados. Algumas queries fazem LEFT JOIN como
-- fallback (ex: triggers 067/068 pegam full_name de la quando
-- customer_id e NULL no plano). Sem sync, edits em customers nao
-- refletem em dental_patients — pode mostrar nome desatualizado
-- em fallback.
--
-- ESTRATEGIA:
--   1. Adicionar customer_id em dental_patients pra criar link 1:1
--   2. Backfill best-effort por cpf/phone matching
--   3. Trigger one-way customers (is_patient=true) → dental_patients
--
-- IDEMPOTENTE em todos os comandos.
-- ============================================================


-- ============================================================
-- 1. LINK: customer_id em dental_patients
-- ============================================================

ALTER TABLE dental_patients
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- Unique apenas onde customer_id e NOT NULL — registros legados
-- sem link nao violam (podem coexistir varios com NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_dental_patients_customer
  ON dental_patients(customer_id)
  WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dental_patients_customer
  ON dental_patients(customer_id);


-- ============================================================
-- 2. BACKFILL: linkar dental_patients existentes a customers
-- ============================================================
--
-- Best-effort matching por (cpf OR phone) na mesma company.
-- NAO cria customers novos pra dental_patients orfaos — esses
-- ficam com customer_id=NULL ate intervencao manual.
-- Roda uma vez (WHERE customer_id IS NULL).

UPDATE dental_patients dp
   SET customer_id = c.id
  FROM customers c
 WHERE dp.customer_id IS NULL
   AND c.is_patient = true
   AND c.company_id = dp.company_id
   AND (
     (NULLIF(dp.cpf, '') IS NOT NULL
        AND NULLIF(c.cpf_cnpj, '') IS NOT NULL
        AND dp.cpf = c.cpf_cnpj)
     OR
     (NULLIF(dp.phone, '') IS NOT NULL
        AND NULLIF(c.phone, '') IS NOT NULL
        AND dp.phone = c.phone)
   );


-- ============================================================
-- 3. TRIGGER: customers → dental_patients (one-way)
-- ============================================================
--
-- Sinal: INSERT ou UPDATE em customers WHERE is_patient = true
-- Acao:
--   - Se ja existe dental_patient com customer_id = NEW.id, UPDATE
--     todos os campos clinicos (espelho).
--   - Senao, INSERT criando o link.
--
-- Quando is_patient vira false (UPDATE), trigger NAO deleta o
-- dental_patient — preserva historico. Se quiser remover, fazer
-- explicitamente.

CREATE OR REPLACE FUNCTION sync_customer_to_dental_patient()
RETURNS TRIGGER AS $$
DECLARE
  v_dp_id UUID;
BEGIN
  -- Reage apenas quando is_patient = true
  IF NEW.is_patient IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  -- Procura dental_patient linkado a este customer
  SELECT id INTO v_dp_id
    FROM dental_patients
   WHERE customer_id = NEW.id
   LIMIT 1;

  IF v_dp_id IS NOT NULL THEN
    -- UPDATE: espelha campos clinicos no registro existente
    UPDATE dental_patients SET
      full_name       = NEW.name,
      cpf             = NEW.cpf_cnpj,
      phone           = NEW.phone,
      email           = NEW.email,
      birth_date      = NEW.birth_date,
      gender          = NEW.gender,
      allergies       = NEW.allergies,
      medical_history = NEW.medical_history,
      medications     = NEW.medications,
      notes           = NEW.notes,
      insurance_name  = NEW.insurance_name,
      insurance_card  = NEW.insurance_card,
      insurance_plan  = NEW.insurance_plan,
      insurance_exp   = NEW.insurance_exp,
      lgpd_consent    = NEW.lgpd_consent,
      lgpd_consent_at = NEW.lgpd_consent_at,
      is_active       = NEW.is_active,
      updated_at      = NOW()
    WHERE id = v_dp_id;
  ELSE
    -- INSERT: cria dental_patient linkado.
    -- ON CONFLICT no UNIQUE customer_id pra cobrir corrida.
    INSERT INTO dental_patients (
      company_id, customer_id, full_name, birth_date, cpf,
      phone, email, gender,
      allergies, medical_history, medications, notes,
      insurance_name, insurance_card, insurance_plan, insurance_exp,
      lgpd_consent, lgpd_consent_at, is_active
    ) VALUES (
      NEW.company_id, NEW.id, NEW.name, NEW.birth_date, NEW.cpf_cnpj,
      NEW.phone, NEW.email, NEW.gender,
      NEW.allergies, NEW.medical_history, NEW.medications, NEW.notes,
      NEW.insurance_name, NEW.insurance_card, NEW.insurance_plan, NEW.insurance_exp,
      COALESCE(NEW.lgpd_consent, false),
      NEW.lgpd_consent_at,
      COALESCE(NEW.is_active, true)
    )
    ON CONFLICT (customer_id) WHERE customer_id IS NOT NULL DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_customer_to_dental_patient
  ON customers;

CREATE TRIGGER trg_sync_customer_to_dental_patient
  AFTER INSERT OR UPDATE
  ON customers
  FOR EACH ROW EXECUTE FUNCTION sync_customer_to_dental_patient();


-- ============================================================
-- 4. DOCUMENTACAO
-- ============================================================

COMMENT ON COLUMN dental_patients.customer_id IS
  'Link 1:1 com customers (D-UNIFY 050+, sync mantido pelo trigger 069). UNIQUE quando NOT NULL.';

COMMENT ON FUNCTION sync_customer_to_dental_patient() IS
  'P2.1 fonte unica (Fase 4): mantem dental_patients sincronizado com customers (is_patient=true). One-way, customers e source of truth. Espelha 17 campos clinicos.';
