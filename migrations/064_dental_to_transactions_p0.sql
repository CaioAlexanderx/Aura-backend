-- ============================================================
-- AURA. — Migration 064: Dental → transactions triggers (P0 fonte única)
--
-- CONTEXTO: ate aqui, dental_treatment_plan_installments (parcelas
-- de orcamentos) e dental_repasse_ledger (repasses pra dentistas)
-- viviam em silo. /financeiro generico (que agrega transactions)
-- nao via essas movimentacoes — DRE da clinica era incompleto.
--
-- Esta migration cria triggers AFTER que projetam esses eventos
-- em transactions automaticamente, com idempotency_key derivada
-- do id da linha original. Permite tambem reverter se o evento
-- for desfeito.
--
-- IDEMPOTENTE: roda em DB limpo (CI) e em prod ja com funcoes/
-- triggers existentes (DROP TRIGGER IF EXISTS + CREATE OR REPLACE
-- FUNCTION + ON CONFLICT DO NOTHING).
--
-- BACKFILL: nao inclui historico ja pago antes desta migration.
-- Se necessario, criar scripts/backfill-dental-to-tx.js depois.
-- Para clinicas em piloto, impacto e zero (historico fica faltando
-- so ate o backfill rodar).
--
-- REFS:
--   - Auditoria: aura-app/Projects/Aura/BACKLOG_FASE4_DUPLICACAO_DENTAL.md
--   - Schema parcelas: 025_dental_treatment_plans.sql
--   - Schema repasse:  047_dental_backfill_for_unify.sql + 053_dental_repasse_realign.sql
-- ============================================================


-- ============================================================
-- 1. RECEITA CLINICA — parcela paga -> transaction (income)
-- ============================================================
--
-- Fonte: dental_treatment_plan_installments
-- Sinal: paid_at sai de NULL (campo mais confiavel que status,
--        que e VARCHAR sem enum e pode ter varios valores)
-- Saida: transactions (type='income', category='receita_clinica',
--        status='confirmed')
--
-- Tambem vincula transactions.id de volta no installment.transaction_id
-- (coluna existia desde 025 mas nao era populada).

CREATE OR REPLACE FUNCTION dental_installment_to_transaction()
RETURNS TRIGGER AS $$
DECLARE
  v_company_id   UUID;
  v_customer_id  UUID;
  v_subject_name TEXT;
  v_idem         TEXT;
  v_existing_id  UUID;
  v_new_tx       UUID;
BEGIN
  -- Caso A: parcela ficou paga (NEW.paid_at IS NOT NULL e antes era NULL,
  -- ou INSERT direto ja com paid_at preenchido).
  IF (TG_OP = 'UPDATE' AND OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL)
     OR (TG_OP = 'INSERT' AND NEW.paid_at IS NOT NULL) THEN

    -- Resolver company_id e nome do paciente via plano
    -- (D-UNIFY: customer_id e fonte de verdade; dental_patients.full_name como fallback).
    SELECT p.company_id,
           p.customer_id,
           COALESCE(c.name, dp.full_name, 'Paciente')
      INTO v_company_id, v_customer_id, v_subject_name
      FROM dental_treatment_plans p
      LEFT JOIN customers       c  ON c.id  = p.customer_id
      LEFT JOIN dental_patients dp ON dp.id = p.patient_id
     WHERE p.id = NEW.plan_id;

    IF v_company_id IS NULL THEN
      -- Sem plano resolvel, abandonar silenciosamente.
      RETURN NEW;
    END IF;

    v_idem := 'dental-installment-paid-' || NEW.id::text;

    -- Idempotencia: se ja existe transaction pra essa parcela, so
    -- garantir o link e sair.
    SELECT id INTO v_existing_id
      FROM transactions
     WHERE idempotency_key = v_idem
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      IF NEW.transaction_id IS DISTINCT FROM v_existing_id THEN
        UPDATE dental_treatment_plan_installments
           SET transaction_id = v_existing_id
         WHERE id = NEW.id;
      END IF;
      RETURN NEW;
    END IF;

    -- Criar transaction de receita confirmada.
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
        || ' (parcela ' || NEW.installment_number || ')',
      'receita_clinica',
      NEW.due_date,
      NEW.paid_at,
      'Gerado automaticamente do modulo Odonto. installment_id=' || NEW.id::text
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_new_tx;

    -- Se ON CONFLICT engoliu (corrida concorrente), pegar o id existente.
    IF v_new_tx IS NULL THEN
      SELECT id INTO v_new_tx
        FROM transactions
       WHERE idempotency_key = v_idem
       LIMIT 1;
    END IF;

    IF v_new_tx IS NOT NULL THEN
      UPDATE dental_treatment_plan_installments
         SET transaction_id = v_new_tx
       WHERE id = NEW.id;
    END IF;
  END IF;

  -- Caso B: parcela voltou a NAO paga (paid_at virou NULL).
  -- Cancelar transaction associada pra evitar receita fantasma no DRE.
  IF TG_OP = 'UPDATE' AND OLD.paid_at IS NOT NULL AND NEW.paid_at IS NULL THEN
    IF OLD.transaction_id IS NOT NULL THEN
      UPDATE transactions
         SET status = 'cancelled',
             updated_at = NOW()
       WHERE id = OLD.transaction_id
         AND status <> 'cancelled';
    ELSE
      -- Fallback: buscar pelo idempotency_key se transaction_id estiver vazio.
      UPDATE transactions
         SET status = 'cancelled',
             updated_at = NOW()
       WHERE idempotency_key = 'dental-installment-paid-' || NEW.id::text
         AND status <> 'cancelled';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dental_installment_to_transaction
  ON dental_treatment_plan_installments;

CREATE TRIGGER trg_dental_installment_to_transaction
  AFTER INSERT OR UPDATE OF paid_at
  ON dental_treatment_plan_installments
  FOR EACH ROW EXECUTE FUNCTION dental_installment_to_transaction();


-- ============================================================
-- 2. REPASSE DENTISTA — status='paid' -> transaction (expense)
-- ============================================================
--
-- Fonte: dental_repasse_ledger
-- Sinal: status vira 'paid' OU paid_at sai de NULL
--        (cobrir UI que mexe em qualquer um dos dois)
-- Saida: transactions (type='expense', category='repasse_dentista',
--        status='confirmed')

CREATE OR REPLACE FUNCTION dental_repasse_to_transaction()
RETURNS TRIGGER AS $$
DECLARE
  v_practitioner_name TEXT;
  v_idem              TEXT;
  v_existing_id       UUID;
  v_new_tx            UUID;
  v_due               DATE;
BEGIN
  -- Caso A: repasse ficou pago.
  IF (TG_OP = 'UPDATE'
        AND ((OLD.status <> 'paid' AND NEW.status = 'paid')
          OR (OLD.paid_at IS NULL AND NEW.paid_at IS NOT NULL)))
     OR (TG_OP = 'INSERT' AND (NEW.status = 'paid' OR NEW.paid_at IS NOT NULL)) THEN

    SELECT name INTO v_practitioner_name
      FROM dental_practitioners
     WHERE id = NEW.practitioner_id;

    v_idem := 'dental-repasse-paid-' || NEW.id::text;

    SELECT id INTO v_existing_id
      FROM transactions
     WHERE idempotency_key = v_idem
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN NEW;
    END IF;

    -- due_date: paid_at se existir, senao hoje.
    v_due := COALESCE(NEW.paid_at::date, CURRENT_DATE);

    INSERT INTO transactions (
      company_id, idempotency_key, type, status, amount,
      description, category, due_date, paid_at, notes
    ) VALUES (
      NEW.company_id,
      v_idem,
      'expense',
      'confirmed',
      NEW.repasse_amount,
      'Repasse — ' || COALESCE(v_practitioner_name, 'Dentista')
        || ' (ref ' || NEW.reference_month || ')',
      'repasse_dentista',
      v_due,
      COALESCE(NEW.paid_at, NOW()),
      'Gerado automaticamente do modulo Odonto. repasse_ledger_id=' || NEW.id::text
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id INTO v_new_tx;

    -- Sem coluna pra vincular de volta no ledger (nao existe transaction_id em
    -- dental_repasse_ledger). Idempotency_key resolve a deduplicacao.
  END IF;

  -- Caso B: repasse saiu de paid -> cancelar transaction.
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'paid' AND NEW.status <> 'paid' THEN
    UPDATE transactions
       SET status = 'cancelled',
           updated_at = NOW()
     WHERE idempotency_key = 'dental-repasse-paid-' || NEW.id::text
       AND status <> 'cancelled';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dental_repasse_to_transaction
  ON dental_repasse_ledger;

CREATE TRIGGER trg_dental_repasse_to_transaction
  AFTER INSERT OR UPDATE OF status, paid_at
  ON dental_repasse_ledger
  FOR EACH ROW EXECUTE FUNCTION dental_repasse_to_transaction();


-- ============================================================
-- 3. DOCUMENTACAO
-- ============================================================

COMMENT ON FUNCTION dental_installment_to_transaction() IS
  'P0 fonte unica (Fase 4): parcela paga em dental_treatment_plan_installments gera transaction (income, receita_clinica). Idempotente via idempotency_key=dental-installment-paid-<id>. Reverte (status=cancelled) se parcela for desmarcada como paga.';

COMMENT ON FUNCTION dental_repasse_to_transaction() IS
  'P0 fonte unica (Fase 4): repasse status=paid em dental_repasse_ledger gera transaction (expense, repasse_dentista). Idempotente via idempotency_key=dental-repasse-paid-<id>. Reverte se status sair de paid.';
