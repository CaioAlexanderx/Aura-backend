-- ============================================================
-- AURA. — Migration 068: Espelhar dental_treatment_payments
-- + corrigir trigger receita_clinica que apontava pra tabela errada.
--
-- CONTEXTO: a trigger criada em 064 (dental_installment_to_transaction)
-- escutava dental_treatment_plan_installments — tabela criada em 025
-- mas NAO E a tabela usada pelo backend. O codigo real (dentalBilling.js)
-- opera em dental_treatment_payments, criada em prod via MCP Supabase
-- sem migration espelho (mesmo padrao reconhecido na 047/065). Trigger
-- 064 nunca disparou.
--
-- IDEMPOTENTE: CREATE TABLE IF NOT EXISTS, ALTER ADD COLUMN IF NOT EXISTS,
-- DROP TRIGGER IF EXISTS, CREATE OR REPLACE FUNCTION, ON CONFLICT.
-- Roda em DB limpo (CI), em prod via psql, ou Supabase MCP sem quebrar.
-- ============================================================


-- ============================================================
-- 1. ESPELHO: dental_treatment_payments
-- ============================================================
--
-- Schema deduzido dos usos em src/routes/dentalBilling.js:
--   - tp.id, tp.treatment_plan_id, tp.installment_number
--   - tp.amount, tp.due_date, tp.paid_at, tp.status, tp.payment_method
-- Em prod a tabela ja existe — IF NOT EXISTS preserva. CI cria do zero.

CREATE TABLE IF NOT EXISTS dental_treatment_payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  treatment_plan_id  UUID NOT NULL REFERENCES dental_treatment_plans(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL DEFAULT 1,
  amount             NUMERIC(12,2) NOT NULL,
  due_date           DATE NOT NULL,
  paid_at            TIMESTAMPTZ,
  payment_method     VARCHAR(30),
  status             VARCHAR(20) NOT NULL DEFAULT 'pending',
  transaction_id     UUID REFERENCES transactions(id) ON DELETE SET NULL,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Garante colunas individuais caso prod tenha schema parcial.
ALTER TABLE dental_treatment_payments
  ADD COLUMN IF NOT EXISTS paid_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_method  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS transaction_id  UUID REFERENCES transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS notes           TEXT,
  ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_dental_treatment_payments_plan
  ON dental_treatment_payments(treatment_plan_id);
CREATE INDEX IF NOT EXISTS idx_dental_treatment_payments_due
  ON dental_treatment_payments(due_date) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_dental_treatment_payments_paid_at
  ON dental_treatment_payments(paid_at) WHERE paid_at IS NOT NULL;

COMMENT ON TABLE dental_treatment_payments IS
  'Parcelas de orcamento dental (criada em prod via MCP, espelhada aqui em 068). NAO confundir com dental_treatment_plan_installments (025, em desuso).';


-- ============================================================
-- 2. CLEANUP: trigger antiga (errada) do 064
-- ============================================================

DROP TRIGGER IF EXISTS trg_dental_installment_to_transaction
  ON dental_treatment_plan_installments;
DROP FUNCTION IF EXISTS dental_installment_to_transaction();


-- ============================================================
-- 3. TRIGGER NOVA: receita_clinica em dental_treatment_payments
-- ============================================================
--
-- Mesma logica do 064, agora apontando pra tabela CORRETA.
--   Sinal: paid_at sai de NULL (igual 064)
--   Saida: transactions (income, category=receita_clinica, status=confirmed)
--   Idempotency_key: dental-payment-paid-<id>
--   Reverso: paid_at vira NULL -> transaction.status=cancelled
--
-- Schema esperado da payment (de dentalBilling.js):
--   id, treatment_plan_id, installment_number, amount, due_date,
--   paid_at, payment_method, status, transaction_id

CREATE OR REPLACE FUNCTION dental_payment_to_transaction()
RETURNS TRIGGER AS $$
DECLARE
  v_company_id   UUID;
  v_customer_id  UUID;
  v_subject_name TEXT;
  v_idem         TEXT;
  v_existing_id  UUID;
  v_new_tx       UUID;
BEGIN
  -- Caso A: parcela ficou paga
  IF (TG_OP = 'UPDATE' AND OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL)
     OR (TG_OP = 'INSERT' AND NEW.paid_at IS NOT NULL) THEN

    -- Resolver company_id e nome do paciente via plano
    -- (D-UNIFY: customer_id em treatment_plans + fallback dental_patients).
    SELECT p.company_id,
           p.customer_id,
           COALESCE(c.name, dp.full_name, 'Paciente')
      INTO v_company_id, v_customer_id, v_subject_name
      FROM dental_treatment_plans p
      LEFT JOIN customers       c  ON c.id  = p.customer_id
      LEFT JOIN dental_patients dp ON dp.id = p.patient_id
     WHERE p.id = NEW.treatment_plan_id;

    IF v_company_id IS NULL THEN
      RETURN NEW;
    END IF;

    v_idem := 'dental-payment-paid-' || NEW.id::text;

    -- Idempotencia
    SELECT id INTO v_existing_id
      FROM transactions
     WHERE idempotency_key = v_idem
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      IF NEW.transaction_id IS DISTINCT FROM v_existing_id THEN
        UPDATE dental_treatment_payments
           SET transaction_id = v_existing_id
         WHERE id = NEW.id;
      END IF;
      RETURN NEW;
    END IF;

    INSERT INTO transactions (
      company_id, idempotency_key, type, status, amount,
      description, category, due_date, paid_at, notes
    ) VALUES (
      v_company_id,
      v_idem,
      'income',
      'confirmed',
      NEW.amount,
      'Recebimento clinico — ' || v_subject_name
        || ' (parcela ' || COALESCE(NEW.installment_number, 1) || ')',
      'receita_clinica',
      NEW.due_date,
      NEW.paid_at,
      'Gerado automaticamente do modulo Odonto. payment_id=' || NEW.id::text
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_new_tx;

    IF v_new_tx IS NULL THEN
      SELECT id INTO v_new_tx
        FROM transactions
       WHERE idempotency_key = v_idem
       LIMIT 1;
    END IF;

    IF v_new_tx IS NOT NULL THEN
      UPDATE dental_treatment_payments
         SET transaction_id = v_new_tx
       WHERE id = NEW.id;
    END IF;
  END IF;

  -- Caso B: parcela voltou a NAO paga
  IF TG_OP = 'UPDATE' AND OLD.paid_at IS NOT NULL AND NEW.paid_at IS NULL THEN
    IF OLD.transaction_id IS NOT NULL THEN
      UPDATE transactions
         SET status = 'cancelled', updated_at = NOW()
       WHERE id = OLD.transaction_id
         AND status <> 'cancelled';
    ELSE
      UPDATE transactions
         SET status = 'cancelled', updated_at = NOW()
       WHERE idempotency_key = 'dental-payment-paid-' || NEW.id::text
         AND status <> 'cancelled';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dental_payment_to_transaction
  ON dental_treatment_payments;

CREATE TRIGGER trg_dental_payment_to_transaction
  AFTER INSERT OR UPDATE OF paid_at ON dental_treatment_payments
  FOR EACH ROW EXECUTE FUNCTION dental_payment_to_transaction();


-- ============================================================
-- 4. DOCUMENTACAO
-- ============================================================

COMMENT ON FUNCTION dental_payment_to_transaction() IS
  'P0 fonte unica corrigido (Fase 4): parcela paga em dental_treatment_payments gera transaction (income, receita_clinica). Substitui dental_installment_to_transaction (064) que apontava pra tabela errada. Idempotente via idempotency_key=dental-payment-paid-<id>.';
