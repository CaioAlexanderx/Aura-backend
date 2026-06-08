-- 167: Fase 2 crediario — capability de encargos (mora/multa) opt-in.
ALTER TABLE credit_plan_configs ADD COLUMN IF NOT EXISTS late_charges_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE credit_plan_configs ADD COLUMN IF NOT EXISTS late_grace_days integer NOT NULL DEFAULT 3;
