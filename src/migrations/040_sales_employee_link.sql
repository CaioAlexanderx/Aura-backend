-- Migration 040: Link sales to employees + employee sales metrics
-- PDV → Clientes (already works via customer_id)
-- PDV → Funcionários (new: employee_id)

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS employee_id UUID REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_sales_employee ON sales (employee_id) WHERE employee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales (customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS total_sales INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_revenue NUMERIC(12,2) DEFAULT 0;
