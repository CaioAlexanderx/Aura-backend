-- ============================================================
-- AURA. Migration 024 — Company Modules (VER-01a)
-- Tracks which vertical modules are active per company
-- Activated by Aura admin, not self-service
-- ============================================================

CREATE TABLE IF NOT EXISTS company_modules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  module_key  VARCHAR(50) NOT NULL,
  is_active   BOOLEAN DEFAULT true,
  activated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  activated_at TIMESTAMPTZ DEFAULT NOW(),
  deactivated_at TIMESTAMPTZ,
  config      JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(company_id, module_key)
);

CREATE INDEX IF NOT EXISTS idx_company_modules_company ON company_modules(company_id);
CREATE INDEX IF NOT EXISTS idx_company_modules_active ON company_modules(company_id, is_active);

-- Pre-defined module keys:
-- 'odonto'    — Odontologia (accent: #06B6D4)
-- 'barber'    — Barbearia/Salao (accent: #F59E0B)
-- 'estetica'  — Estetica (accent: #EC4899)
-- 'pet'       — Pet Shop (accent: #10B981)
-- 'food'      — Food Service (accent: #EF4444)
-- 'moda'      — Moda/Varejo (accent: #8B5CF6)
-- 'academia'  — Academia (accent: #3B82F6)

COMMENT ON TABLE company_modules IS 'Vertical modules activated per company. Admin-only activation.';
COMMENT ON COLUMN company_modules.module_key IS 'Module identifier: odonto, barber, estetica, pet, food, moda, academia';
COMMENT ON COLUMN company_modules.config IS 'Module-specific config JSON (e.g., number of chairs for dental)';
