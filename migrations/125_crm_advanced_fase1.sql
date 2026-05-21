-- ============================================================
-- 125_crm_advanced_fase1.sql
-- CRM Comercial - Fase 1: expected_mrr, last_activity, score
-- ============================================================

-- 1) Colunas novas em sales_leads
ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS expected_mrr NUMERIC(10,2);
ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE sales_leads ADD COLUMN IF NOT EXISTS dynamic_score INT DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sales_leads_last_activity ON sales_leads(last_activity_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_sales_leads_dynamic_score ON sales_leads(dynamic_score DESC);
CREATE INDEX IF NOT EXISTS idx_sales_leads_expected_plan ON sales_leads(expected_plan) WHERE expected_plan IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_leads_rotten ON sales_leads(rotten_since) WHERE rotten_since IS NOT NULL;

UPDATE sales_leads
SET last_activity_at = GREATEST(updated_at, COALESCE(last_contact_at, '1970-01-01'::timestamptz))
WHERE last_activity_at IS NULL;

-- 2) target_mrr em lead_goals
ALTER TABLE lead_goals ADD COLUMN IF NOT EXISTS target_mrr NUMERIC(10,2) DEFAULT 0;

-- 3) Funcao core de calculo (campos diretos -> usavel no BEFORE UPDATE)
CREATE OR REPLACE FUNCTION compute_lead_score_from_fields(
  p_status TEXT,
  p_expected_plan TEXT,
  p_google_rating NUMERIC,
  p_google_reviews INT,
  p_last_activity_at TIMESTAMPTZ,
  p_rotten_since TIMESTAMPTZ,
  p_phone TEXT
) RETURNS INT
LANGUAGE plpgsql STABLE AS $$
DECLARE score INT := 0;
BEGIN
  IF p_google_rating IS NOT NULL THEN
    score := score + LEAST(20, (p_google_rating * 4)::int);
  END IF;
  IF p_google_reviews IS NOT NULL THEN
    score := score + LEAST(15, (p_google_reviews / 10)::int);
  END IF;
  score := score + CASE p_status
    WHEN 'demo'       THEN 30
    WHEN 'interested' THEN 20
    WHEN 'responded'  THEN 10
    WHEN 'contacted'  THEN 5
    WHEN 'converted'  THEN 40
    WHEN 'lost'       THEN -20
    ELSE 0
  END;
  score := score + CASE p_expected_plan
    WHEN 'expansao'  THEN 15
    WHEN 'negocio'   THEN 10
    WHEN 'essencial' THEN 5
    ELSE 0
  END;
  IF p_last_activity_at IS NOT NULL THEN
    score := score + CASE
      WHEN p_last_activity_at >= NOW() - INTERVAL '3 days'  THEN 15
      WHEN p_last_activity_at >= NOW() - INTERVAL '7 days'  THEN 10
      WHEN p_last_activity_at >= NOW() - INTERVAL '14 days' THEN 5
      ELSE 0
    END;
  END IF;
  IF p_rotten_since IS NOT NULL THEN
    score := score - 20;
  END IF;
  IF p_phone IS NOT NULL AND p_phone != '' THEN
    score := score + 5;
  END IF;
  RETURN GREATEST(0, score);
END;
$$;

-- 4) Wrapper que aceita lead_id
CREATE OR REPLACE FUNCTION compute_lead_score(p_lead_id UUID) RETURNS INT
LANGUAGE plpgsql STABLE AS $$
DECLARE l RECORD;
BEGIN
  SELECT status, expected_plan, google_rating, google_reviews,
         last_activity_at, rotten_since, phone
  INTO l
  FROM sales_leads WHERE id = p_lead_id;
  IF NOT FOUND THEN RETURN 0; END IF;

  RETURN compute_lead_score_from_fields(
    l.status, l.expected_plan, l.google_rating, l.google_reviews,
    l.last_activity_at, l.rotten_since, l.phone
  );
END;
$$;

-- 5) Trigger AFTER INSERT lead_interactions -> atualiza last_activity, limpa rotten
CREATE OR REPLACE FUNCTION trg_lead_interaction_after_insert_fn() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE sales_leads
  SET last_activity_at = NEW.created_at,
      rotten_since     = NULL,
      updated_at       = NOW()
  WHERE id = NEW.lead_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lead_interaction_after_insert ON lead_interactions;
CREATE TRIGGER trg_lead_interaction_after_insert
AFTER INSERT ON lead_interactions
FOR EACH ROW EXECUTE FUNCTION trg_lead_interaction_after_insert_fn();

-- 6) Trigger BEFORE UPDATE sales_leads -> recalcula score
CREATE OR REPLACE FUNCTION trg_sales_leads_recompute_score_fn() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.status         IS DISTINCT FROM OLD.status)
    OR (NEW.expected_plan IS DISTINCT FROM OLD.expected_plan)
    OR (NEW.rotten_since  IS DISTINCT FROM OLD.rotten_since)
    OR (NEW.google_rating IS DISTINCT FROM OLD.google_rating)
    OR (NEW.google_reviews IS DISTINCT FROM OLD.google_reviews)
    OR (NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at)
    OR (NEW.phone IS DISTINCT FROM OLD.phone)
  THEN
    NEW.dynamic_score := compute_lead_score_from_fields(
      NEW.status, NEW.expected_plan, NEW.google_rating, NEW.google_reviews,
      NEW.last_activity_at, NEW.rotten_since, NEW.phone
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_leads_recompute_score ON sales_leads;
CREATE TRIGGER trg_sales_leads_recompute_score
BEFORE UPDATE ON sales_leads
FOR EACH ROW EXECUTE FUNCTION trg_sales_leads_recompute_score_fn();

-- 7) Trigger BEFORE INSERT sales_leads -> score inicial
CREATE OR REPLACE FUNCTION trg_sales_leads_initial_score_fn() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.dynamic_score := compute_lead_score_from_fields(
    COALESCE(NEW.status, 'new'), NEW.expected_plan, NEW.google_rating, NEW.google_reviews,
    COALESCE(NEW.last_activity_at, NOW()), NEW.rotten_since, NEW.phone
  );
  IF NEW.last_activity_at IS NULL THEN
    NEW.last_activity_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_leads_initial_score ON sales_leads;
CREATE TRIGGER trg_sales_leads_initial_score
BEFORE INSERT ON sales_leads
FOR EACH ROW EXECUTE FUNCTION trg_sales_leads_initial_score_fn();

-- 8) Mark rotten em massa
CREATE OR REPLACE FUNCTION mark_rotten_leads(p_threshold_days INT DEFAULT 14) RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE affected INT;
BEGIN
  UPDATE sales_leads
  SET rotten_since = NOW()
  WHERE rotten_since IS NULL
    AND status NOT IN ('converted','lost')
    AND last_activity_at IS NOT NULL
    AND last_activity_at < NOW() - (p_threshold_days || ' days')::interval;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

-- 9) Backfill scores
UPDATE sales_leads SET dynamic_score = compute_lead_score_from_fields(
  status, expected_plan, google_rating, google_reviews,
  last_activity_at, rotten_since, phone
);
