// ============================================================
// AURA. — Serviço de Histórico Financeiro (BE-04)
// ============================================================

const db = require('../config/database');

/**
 * Histórico financeiro mensal com comparativo anual
 * @param {string} companyId
 * @param {object} options - { year, granularity }
 *   year:        ano de referência (padrão: ano atual)
 *   granularity: 'month' | 'quarter' (padrão: month)
 */
async function getFinancialHistory(companyId, options = {}) {
  const currentYear = new Date().getFullYear();
  const { year = currentYear, granularity = 'month' } = options;

  const yearNum  = parseInt(year);
  const prevYear = yearNum - 1;

  const [current, previous, summary] = await Promise.all([
    getYearData(companyId, yearNum, granularity),
    getYearData(companyId, prevYear, granularity),
    getYearSummary(companyId, yearNum),
  ]);

  // Mesclar períodos para comparativo
  const periods = mergePeriods(current, previous, granularity);

  return {
    year:       yearNum,
    prev_year:  prevYear,
    granularity,
    summary,
    periods,
  };
}

/**
 * Dados financeiros de um ano inteiro agrupados por mês ou trimestre
 */
async function getYearData(companyId, year, granularity) {
  const groupExpr = granularity === 'quarter'
    ? `EXTRACT(QUARTER FROM due_date)::int`
    : `EXTRACT(MONTH FROM due_date)::int`;

  const labelExpr = granularity === 'quarter'
    ? `CONCAT('Q', EXTRACT(QUARTER FROM due_date)::int)`
    : `TO_CHAR(due_date, 'Mon')`;

  const { rows } = await db.query(`
    SELECT
      ${groupExpr}                                        AS period_num,
      ${labelExpr}                                        AS period_label,
      COALESCE(SUM(CASE WHEN type = 'income'  AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type = 'expense' AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS expense,
      COALESCE(SUM(CASE WHEN type = 'income'  AND status = 'pending'   THEN amount ELSE 0 END), 0) AS income_pending,
      COALESCE(SUM(CASE WHEN type = 'expense' AND status = 'pending'   THEN amount ELSE 0 END), 0) AS expense_pending,
      COUNT(CASE WHEN type = 'income'  THEN 1 END)::int  AS income_count,
      COUNT(CASE WHEN type = 'expense' THEN 1 END)::int  AS expense_count
    FROM transactions
    WHERE company_id = $1
      AND EXTRACT(YEAR FROM due_date) = $2
      AND status != 'cancelled'
    GROUP BY 1, 2
    ORDER BY 1
  `, [companyId, year]);

  return rows.map(r => ({
    period_num:      r.period_num,
    period_label:    r.period_label,
    income:          parseFloat(r.income),
    expense:         parseFloat(r.expense),
    result:          parseFloat((r.income - r.expense).toFixed(2)),
    income_pending:  parseFloat(r.income_pending),
    expense_pending: parseFloat(r.expense_pending),
    income_count:    r.income_count,
    expense_count:   r.expense_count,
  }));
}

/**
 * Resumo anual: totais, melhor mês, pior mês, média mensal
 */
async function getYearSummary(companyId, year) {
  const { rows } = await db.query(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income'  AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN type = 'expense' AND status = 'confirmed' THEN amount ELSE 0 END), 0) AS total_expense,
      COALESCE(SUM(CASE WHEN type = 'income'  AND status = 'pending'   THEN amount ELSE 0 END), 0) AS pending_income,
      COALESCE(SUM(CASE WHEN type = 'expense' AND status = 'pending'   THEN amount ELSE 0 END), 0) AS pending_expense
    FROM transactions
    WHERE company_id = $1
      AND EXTRACT(YEAR FROM due_date) = $2
      AND status != 'cancelled'
  `, [companyId, year]);

  const r = rows[0];
  const totalIncome  = parseFloat(r.total_income);
  const totalExpense = parseFloat(r.total_expense);
  const netResult    = parseFloat((totalIncome - totalExpense).toFixed(2));

  return {
    total_income:    totalIncome,
    total_expense:   totalExpense,
    net_result:      netResult,
    pending_income:  parseFloat(r.pending_income),
    pending_expense: parseFloat(r.pending_expense),
    avg_monthly_income:  parseFloat((totalIncome / 12).toFixed(2)),
    avg_monthly_expense: parseFloat((totalExpense / 12).toFixed(2)),
    margin_pct: totalIncome > 0
      ? parseFloat(((netResult / totalIncome) * 100).toFixed(1))
      : 0,
  };
}

/**
 * Mescla dados do ano atual com o anterior para comparativo
 */
function mergePeriods(current, previous, granularity) {
  const total = granularity === 'quarter' ? 4 : 12;
  const result = [];

  for (let i = 1; i <= total; i++) {
    const curr = current.find(p => p.period_num === i);
    const prev = previous.find(p => p.period_num === i);

    const currIncome  = curr?.income  || 0;
    const prevIncome  = prev?.income  || 0;
    const currExpense = curr?.expense || 0;
    const prevExpense = prev?.expense || 0;

    result.push({
      period_num:   i,
      period_label: curr?.period_label || prev?.period_label || `P${i}`,
      current: {
        income:   currIncome,
        expense:  currExpense,
        result:   parseFloat((currIncome - currExpense).toFixed(2)),
        income_pending:  curr?.income_pending  || 0,
        expense_pending: curr?.expense_pending || 0,
      },
      previous: {
        income:  prevIncome,
        expense: prevExpense,
        result:  parseFloat((prevIncome - prevExpense).toFixed(2)),
      },
      // Variação % vs ano anterior
      income_growth_pct: prevIncome > 0
        ? parseFloat((((currIncome - prevIncome) / prevIncome) * 100).toFixed(1))
        : null,
      expense_growth_pct: prevExpense > 0
        ? parseFloat((((currExpense - prevExpense) / prevExpense) * 100).toFixed(1))
        : null,
    });
  }

  return result;
}

module.exports = { getFinancialHistory, getYearSummary };
