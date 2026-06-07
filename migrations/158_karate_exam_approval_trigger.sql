-- ============================================================
-- AURA KARATÊ — Migration 158: Trigger de aprovação de exame
-- Ao marcar um candidato como 'approved', insere a nova faixa em
-- karate_belt_history (append-only). Só dispara na transição p/ 'approved'.
-- search_path pinado (CI roda em Postgres puro).
-- APLICADA em 07/06/2026 no Supabase hawtujkztrjpvvkihowb.
-- ============================================================

CREATE OR REPLACE FUNCTION karate_on_exam_approved()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_fed  UUID;
  v_date DATE;
BEGIN
  IF NEW.status = 'approved' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
    SELECT federation_id, event_date INTO v_fed, v_date
      FROM karate_belt_exams WHERE id = NEW.exam_id;

    INSERT INTO karate_belt_history
      (student_id, federation_id, belt_level, belt_name, belt_schema, graduated_at, exam_id, notes)
    VALUES
      (NEW.student_id, v_fed, NEW.target_belt,
       COALESCE(NEW.target_belt_name, NEW.target_belt),
       NEW.belt_schema, COALESCE(v_date, CURRENT_DATE), NEW.exam_id, NEW.result_notes);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_karate_on_exam_approved ON karate_belt_exam_candidates;
CREATE TRIGGER trg_karate_on_exam_approved
  AFTER INSERT OR UPDATE OF status ON karate_belt_exam_candidates
  FOR EACH ROW EXECUTE FUNCTION karate_on_exam_approved();

-- FIM DA MIGRATION 158
