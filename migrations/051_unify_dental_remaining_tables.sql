-- ============================================================
-- AURA. — Migration 051: D-UNIFY completo (tabelas restantes)
-- Adiciona customer_id nas 11 tabelas dental_* que ainda usavam
-- patient_id apontando para dental_patients.
--
-- Aplicada em producao via MCP Supabase em 23/04/2026.
-- ============================================================

-- ── RESTRICT: dados clinicos/legais ────────────────────────
ALTER TABLE dental_images
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE dental_lab_orders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE dental_specialty_forms
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT;

ALTER TABLE dental_tiss_guides
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT;

-- ── CASCADE: dados derivados ───────────────────────────────
ALTER TABLE dental_checkins
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE dental_periodontal_chart
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE dental_portal_tokens
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;

ALTER TABLE dental_waitlist
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE CASCADE;

-- ── SET NULL: historico que sobrevive ao paciente ──────────
ALTER TABLE dental_automation_log
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE dental_billing_reminders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

ALTER TABLE dental_leads
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- ── Indices para joins ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_dental_automation_log_customer ON dental_automation_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_billing_rem_customer    ON dental_billing_reminders(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_checkins_customer       ON dental_checkins(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_images_customer         ON dental_images(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_lab_orders_customer     ON dental_lab_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_leads_customer          ON dental_leads(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_perio_customer          ON dental_periodontal_chart(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_portal_tokens_customer  ON dental_portal_tokens(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_specialty_forms_customer ON dental_specialty_forms(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_tiss_customer           ON dental_tiss_guides(customer_id);
CREATE INDEX IF NOT EXISTS idx_dental_waitlist_customer       ON dental_waitlist(customer_id);

-- ── Tornar patient_id nullable onde nao for ────────────────
DO $$ BEGIN
  BEGIN ALTER TABLE dental_checkins            ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_images              ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_lab_orders          ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_periodontal_chart   ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_portal_tokens       ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_specialty_forms     ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_tiss_guides         ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_waitlist            ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_automation_log      ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_billing_reminders   ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE dental_leads               ALTER COLUMN patient_id DROP NOT NULL; EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;
