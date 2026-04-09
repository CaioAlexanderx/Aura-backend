-- Migration 041: Module visibility overrides per company
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS module_overrides JSONB DEFAULT '{}';

COMMENT ON COLUMN companies.module_overrides IS 'Admin overrides: module_key -> true (force show) / false (force hide) / absent (plan default)';
