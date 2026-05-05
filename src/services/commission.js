// BE-19 — Cálculo de comissão de vendas por funcionário
// sales.seller_id → users.id ← employees.user_id

const pool = require('../config/database');

/**
 * Calcula comissão de um funcionário em um mês.
 * Retorna o total vendido, o percentual e o valor da comissão.
 */
async function calculateEmployeeCommission(company_id, employee_id, reference_month) {
  // reference_month: 'YYYY-MM' (ex: '2026-03')
  const [year, month] = reference_month.split('-').map(Number);
  const startDate = new Date(year, month - 1, 1);
  const endDate   = new Date(year, month, 1); // início do próximo mês

  // Buscar funcionário com user_id e configuração de comissão
  const empResult = await pool.query(
    `SELECT e.id, e.name, e.role, e.user_id, e.commission_enabled, e.commission_rate
     FROM employees e
     WHERE e.id = $1 AND e.company_id = $2 AND e.is_active = true`,
    [employee_id, company_id]
  );

  if (empResult.rows.length === 0) {
    return null;
  }

  const employee = empResult.rows[0];

  // Se não tem comissão habilitada, retornar zerado
  if (!employee.commission_enabled || !employee.commission_rate) {
    return {
      employee_id:        employee.id,
      employee_name:      employee.name,
      role:               employee.role,
      commission_enabled: false,
      commission_rate:    null,
      total_revenue:      0,
      total_sales:        0,
      commission_amount:  0,
      reference_month,
    };
  }

  // Somar vendas do período onde seller_id = employee.user_id
  let salesResult;
  if (employee.user_id) {
    salesResult = await pool.query(
      `SELECT
         COALESCE(SUM(s.total_amount), 0) AS total_revenue,
         COUNT(*) AS total_sales
       FROM sales s
       WHERE s.company_id = $1
         AND s.seller_id  = $2
         AND s.created_at >= $3
         AND s.created_at <  $4`,
      [company_id, employee.user_id, startDate, endDate]
    );
  } else {
    // Funcionário sem user_id vinculado — vendas não rastreáveis
    salesResult = { rows: [{ total_revenue: 0, total_sales: 0 }] };
  }

  const { total_revenue, total_sales } = salesResult.rows[0];
  const commission_amount = (parseFloat(total_revenue) * parseFloat(employee.commission_rate)) / 100;

  return {
    employee_id:        employee.id,
    employee_name:      employee.name,
    role:               employee.role,
    commission_enabled: true,
    commission_rate:    parseFloat(employee.commission_rate),
    total_revenue:      parseFloat(total_revenue),
    total_sales:        parseInt(total_sales),
    commission_amount:  Math.round(commission_amount * 100) / 100,
    reference_month,
  };
}

/**
 * Resumo de comissões de todos os funcionários ativos de uma empresa no mês.
 */
async function getCommissionSummary(company_id, reference_month) {
  const [year, month] = reference_month.split('-').map(Number);
  const startDate = new Date(year, month - 1, 1);
  const endDate   = new Date(year, month, 1);

  const result = await pool.query(
    `SELECT
       e.id              AS employee_id,
       e.name            AS employee_name,
       e.role,
       e.commission_enabled,
       e.commission_rate,
       e.user_id,
       COALESCE(SUM(s.total_amount), 0) AS total_revenue,
       COUNT(s.id)                       AS total_sales
     FROM employees e
     LEFT JOIN sales s
       ON s.company_id = e.company_id
      AND s.seller_id  = e.user_id
      AND s.created_at >= $2
      AND s.created_at <  $3
     WHERE e.company_id = $1
       AND e.is_active  = true
     GROUP BY e.id, e.name, e.role, e.commission_enabled, e.commission_rate, e.user_id
     ORDER BY total_revenue DESC`,
    [company_id, startDate, endDate]
  );

  return result.rows.map(row => ({
    employee_id:        row.employee_id,
    employee_name:      row.employee_name,
    role:               row.role,
    commission_enabled: row.commission_enabled,
    commission_rate:    row.commission_rate ? parseFloat(row.commission_rate) : null,
    total_revenue:      parseFloat(row.total_revenue),
    total_sales:        parseInt(row.total_sales),
    commission_amount:  row.commission_enabled && row.commission_rate
      ? Math.round(parseFloat(row.total_revenue) * parseFloat(row.commission_rate) / 100 * 100) / 100
      : 0,
    has_user_linked:    !!row.user_id,
    reference_month,
  }));
}

module.exports = { calculateEmployeeCommission, getCommissionSummary };
