-- ============================================================
-- AURA. -- PLAN-02: Employees no Essencial (cadastro basico)
--
-- Pra suportar cadastro simples de "vendedores" no plano Essencial
-- (sem dados de folha), tornamos opcionais os campos exclusivos de
-- folha de pagamento. Em planos Negocio+, a UI continua exigindo
-- todos os campos antes de calcular salario/holerite.
--
-- Mudancas:
--   - cpf            NOT NULL -> NULL  (opcional)
--   - admission_date NOT NULL -> NULL  (opcional)
--   - base_salary    NOT NULL -> NULL  (opcional; salary ja era nullable)
--   - UNIQUE (company_id, cpf) vira partial: WHERE cpf IS NOT NULL
--     (permite N funcionarios sem CPF na mesma empresa)
--
-- Aplicado via Supabase MCP em 12/05/2026; este arquivo existe pra
-- CI rodar em DB limpo (ls migrations/*.sql | sort).
-- ============================================================

ALTER TABLE employees
  ALTER COLUMN cpf            DROP NOT NULL,
  ALTER COLUMN admission_date DROP NOT NULL,
  ALTER COLUMN base_salary    DROP NOT NULL;

ALTER TABLE employees
  DROP CONSTRAINT IF EXISTS employees_company_id_cpf_key;

CREATE UNIQUE INDEX IF NOT EXISTS employees_company_id_cpf_key
  ON employees (company_id, cpf)
  WHERE cpf IS NOT NULL;
