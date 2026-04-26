-- ============================================================
-- AURA. — Migration 067: Dental TISS → transactions (P2 fonte única)
--
-- Fecha o ultimo silo financeiro do modulo odonto: pagamentos
-- TISS de operadoras (planos de saude) retornados via lote ANS.
-- Antes desta migration, dental_tiss_guides.paid_value preenchido
-- nao virava transaction no DRE generico — receita TISS opaca.
--
-- ESCOPO P2 ajustado: P2.1 (sync patients ↔ customers) descoberto
-- como ja-resolvido durante a investigacao (src/routes/dentalPatients.js
-- ja opera direto em customers via is_patient=true). Esta migration
-- entrega so P2.2 (TISS).
--
-- IDEMPOTENTE: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS
-- + ON CONFLICT DO NOTHING. Roda em DB limpo (CI), em prod via psql,
-- ou via Supabase MCP sem quebrar nada.
--
-- BACKFILL: nao inclui guias ja pagas antes desta migration. Pra base
-- atual (clinicas em piloto), impacto e zero.
--
-- REFS:
--   - Schema TISS: 056_tiss_full_schema.sql + 057 seed
--   - Padrao trigger: 064_dental_to_transactions_p0.sql
--   - Auditoria: aura-app/Projects/Aura/BACKLOG_FASE4_DUPLICACAO_DENTAL.md
-- ============================================================


-- ============================================================
-- TISS — guia paga -> transaction (income, receita_tiss)
-- ============================================================
--
-- Fonte: dental_tiss_guides
-- Sinal: paid_at sai de NULL E paid_value > 0
--        (paid_value > 0 evita criar transaction de R$0 em guias
--         glosadas integralmente)
-- Saida: transactions (type=income, category=receita_tiss,
--        status=confirmed, amount=paid_value)
--
-- Description enriquecida via JOINs:
--   - operadora: dental_insurance.razao_social via batch ou patient_insurance
--   - paciente: customers.name via guide.customer_id
--
-- LIMITACAO: pagamento incremental (operadora complementa um valor
-- ja pago) NAO atualiza a transaction. Idempotency_key garante
-- nao-duplicacao mas perde o delta. Solucao futura: trigger separado
-- em UPDATE OF paid_value que cria transaction adicional pelo delta.

CREATE OR REPLACE FUNCTION dental_tiss_guide_to_transaction()
RETURNS TRIGGER AS $$
DECLARE
  v_company_id   UUID;
  v_insurer_name TEXT;
  v_subject_name TEXT;
  v_idem         TEXT;
  v_existing_id  UUID;
  v_new_tx       UUID;
  v_due          DATE;
BEGIN
  -- Caso A: guia ficou paga (paid_at saiu de NULL e tem valor recebido).
  IF (TG_OP = 'UPDATE'
        AND OLD.paid_at IS NULL
        AND NEW.paid_at IS NOT NULL
        AND COALESCE(NEW.paid_value, 0) > 0)
     OR (TG_OP = 'INSERT'
        AND NEW.paid_at IS NOT NULL
        AND COALESCE(NEW.paid_value, 0) > 0) THEN

    -- Resolver company_id (preferencia: batch.company_id; fallback: NEW.company_id se existir).
    -- Resolver operadora via batch.insurance_id (preferencia) OU
    -- guide.patient_insurance_id -> dental_patient_insurance.insurance_id (fallback).
    -- Resolver nome do paciente via NEW.customer_id (D-UNIFY 050/051).
    SELECT
      COALESCE(b.company_id, NEW.company_id),
      COALESCE(NULLIF(ins.razao_social, ''), 'Operadora'),
      COALESCE(NULLIF(c.name, ''), 'Paciente')
    INTO
      v_company_id, v_insurer_name, v_subject_name
    FROM dental_tiss_guides g_self
    LEFT JOIN dental_tiss_batches      b   ON b.id   = NEW.batch_id
    LEFT JOIN dental_patient_insurance pi  ON pi.id  = NEW.patient_insurance_id
    LEFT JOIN dental_insurance         ins ON ins.id = COALESCE(b.insurance_id, pi.insurance_id)
    LEFT JOIN customers                c   ON c.id   = NEW.customer_id
    WHERE g_self.id = NEW.id
    LIMIT 1;

    IF v_company_id IS NULL THEN
      -- Sem company_id resolvel, abandona silenciosamente.
      RETURN NEW;
    END IF;

    v_idem := 'dental-tiss-guide-paid-' || NEW.id::text;

    -- Idempotencia: se ja existe transaction pra essa guia, sair.
    SELECT id INTO v_existing_id
      FROM transactions
     WHERE idempotency_key = v_idem
     LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      RETURN NEW;
    END IF;

    v_due := NEW.paid_at::date;

    INSERT INTO transactions (
      company_id, idempotency_key, type, status, amount,
      description, category, due_date, paid_at, notes
    ) VALUES (
      v_company_id,
      v_idem,
      'income',
      'confirmed',
      NEW.paid_value,
      'Recebimento TISS — ' || v_insurer_name
        || ' (' || v_subject_name || ')',
      'receita_tiss',
      v_due,
      NEW.paid_at,
      'Gerado automaticamente do modulo Odonto/TISS. tiss_guide_id=' || NEW.id::text
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  -- Caso B: guia voltou a NAO paga (paid_at virou NULL).
  -- Cancelar transaction associada pra evitar receita fantasma no DRE.
  IF TG_OP = 'UPDATE'
     AND OLD.paid_at IS NOT NULL
     AND NEW.paid_at IS NULL THEN
    UPDATE transactions
       SET status = 'cancelled',
           updated_at = NOW()
     WHERE idempotency_key = 'dental-tiss-guide-paid-' || NEW.id::text
       AND status <> 'cancelled';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dental_tiss_guide_to_transaction
  ON dental_tiss_guides;

CREATE TRIGGER trg_dental_tiss_guide_to_transaction
  AFTER INSERT OR UPDATE OF paid_at, paid_value
  ON dental_tiss_guides
  FOR EACH ROW EXECUTE FUNCTION dental_tiss_guide_to_transaction();


-- ============================================================
-- DOCUMENTACAO
-- ============================================================

COMMENT ON FUNCTION dental_tiss_guide_to_transaction() IS
  'P2 fonte unica (Fase 4): guia TISS paga em dental_tiss_guides gera transaction (income, receita_tiss). Idempotente via idempotency_key=dental-tiss-guide-paid-<id>. Reverte se paid_at sair de NULL. Limitacao: pagamento incremental nao atualiza valor (cria transaction inicial e congela). Categoria receita_tiss complementa receita_clinica (P0) no DRE da clinica.';
