-- Migration 037: Add payroll fields to employees table
-- Sprint 3: CRUD Funcionarios + Folha

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS role VARCHAR(100),
  ADD COLUMN IF NOT EXISTS salary NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS admission_date DATE,
  ADD COLUMN IF NOT EXISTS cpf VARCHAR(14),
  ADD COLUMN IF NOT EXISTS pis VARCHAR(20),
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
  ADD COLUMN IF NOT EXISTS email VARCHAR(255),
  ADD COLUMN IF NOT EXISTS work_hours INTEGER DEFAULT 220;

-- Index for payroll queries
CREATE INDEX IF NOT EXISTS idx_employees_company_active
  ON employees (company_id, is_active, status);
