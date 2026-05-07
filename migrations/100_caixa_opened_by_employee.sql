-- ============================================================================
-- 100_caixa_opened_by_employee.sql
-- Adiciona opened_by_employee_id em caixa_sessoes.
--
-- Contexto: o aura-app passou a oferecer um picker de 'funcionario
-- responsavel' no fluxo de abertura de caixa (PDV). O req.user (auth)
-- continua sendo gravado em opened_by como audit trail; o employee
-- escolhido pelo operador vira opened_by_employee_id e e o que aparece
-- no header do PDV e no PDF de fechamento.
--
-- Coluna NULLABLE pra preservar compatibilidade com fluxo antigo (sem
-- picker). Empresas em planos sem empregados (Essencial) abrem caixa
-- normalmente sem preencher esse campo.
-- ============================================================================

ALTER TABLE caixa_sessoes
  ADD COLUMN IF NOT EXISTS opened_by_employee_id UUID
    REFERENCES employees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_caixa_sessoes_opened_by_employee
  ON caixa_sessoes(opened_by_employee_id)
  WHERE opened_by_employee_id IS NOT NULL;

COMMENT ON COLUMN caixa_sessoes.opened_by_employee_id IS
  'Funcionario operacional responsavel pelo caixa (escolhido no fluxo
   do PDV). Diferente de opened_by, que e o user autenticado (audit).
   NULL em sessoes legadas ou em planos sem empregados.';
