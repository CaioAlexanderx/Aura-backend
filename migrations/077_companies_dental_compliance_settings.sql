-- ============================================================
-- 077_companies_dental_compliance_settings.sql
-- PR36 (2026-04-28): configuracoes de compliance odonto que nao
-- sao automatizaveis via API publica e precisam cadastro do Admin.
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS vigilancia_alvara_expires_at date;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS vigilancia_alvara_number text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS vigilancia_alvara_reminder_enabled boolean DEFAULT true;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cro_state text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cro_pj_number text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cro_rt_number text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cro_rt_user_id uuid REFERENCES users(id);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS cnes_number text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS uses_controlled_meds boolean DEFAULT false;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS dental_compliance_enabled boolean DEFAULT true;

COMMENT ON COLUMN companies.vigilancia_alvara_expires_at IS 'Data de validade do alvara da vigilancia sanitaria. Sistema lembra 60/30/7d antes (PR36).';
COMMENT ON COLUMN companies.vigilancia_alvara_reminder_enabled IS 'Toggle do Admin: receber ou nao lembretes de alvara (PR36).';
COMMENT ON COLUMN companies.cro_pj_number IS 'Inscricao da clinica no CRO (PJ) - PR36.';
COMMENT ON COLUMN companies.cro_rt_user_id IS 'Usuario marcado como Responsavel Tecnico no CRO. Default: dono - PR36.';
COMMENT ON COLUMN companies.uses_controlled_meds IS 'Se true, ativa lembretes SNGPC (PR36).';
