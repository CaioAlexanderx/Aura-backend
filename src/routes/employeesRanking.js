// ============================================================
// AURA. — Ranking de Funcionários + Link PDV (BE-02 + BE-REV-04)
// GET /companies/:id/employees/ranking
// Now includes PDV sales data: revenue, count, ticket, trend
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db = require('../config/database');

const VALID_PERIODS = ['week', 'month', 'year', 'custom'];

function resolvePeriod(period, startDate, endDate) {
  const now = new Date();
  switch (period) {
    case 'week': {
      const start = new Date(now); start.setDate(now.getDate() - now.getDay());
      start.setHours(0,0,0,0);
      const end = new Date(start); end.setDate(start.getDate() + 7);
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
    case 'year': {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear() + 1, 0, 1);
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
    case 'custom':
      return { startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString() };
    default: { // month
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
  }
}

/**
 * GET /companies/:id/employees/ranking
 * BE-REV-04: Now includes PDV sales linked by employee_id
 */
router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { period = 'month', start_date, end_date } = req.query;

    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({ error: `period inválido. Use: ${VALID_PERIODS.join(', ')}` });
    }
    if (period === 'custom' && (!start_date || !end_date)) {
      return res.status(400).json({ error: 'Para period=custom, informe start_date e end_date' });
    }

    const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

    // BE-REV-04: Query employees with PDV sales data
    const { rows: employees } = await db.query(`
      SELECT
        e.id,
        e.full_name,
        e.role AS job_role,
        COALESCE(sales.total_sales, 0) AS total_sales,
        COALESCE(sales.total_revenue, 0) AS total_revenue,
        CASE WHEN COALESCE(sales.total_sales, 0) > 0
          THEN ROUND(sales.total_revenue / sales.total_sales, 2)
          ELSE 0
        END AS avg_ticket,
        COALESCE(prev.prev_revenue, 0) AS prev_revenue
      FROM employees e
      LEFT JOIN LATERAL (
        SELECT
          COUNT(s.id) AS total_sales,
          COALESCE(SUM(s.total_amount), 0) AS total_revenue
        FROM sales s
        WHERE s.company_id = $1
          AND s.employee_id = e.id
          AND s.created_at >= $2
          AND s.created_at < $3
      ) sales ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(s2.total_amount), 0) AS prev_revenue
        FROM sales s2
        WHERE s2.company_id = $1
          AND s2.employee_id = e.id
          AND s2.created_at >= ($2::timestamptz - ($3::timestamptz - $2::timestamptz))
          AND s2.created_at < $2
      ) prev ON true
      WHERE e.company_id = $1 AND e.is_active = true
      ORDER BY sales.total_revenue DESC NULLS LAST
    `, [companyId, startDate, endDate]);

    // Total revenue for share calculation
    const totalRevenue = employees.reduce((s, e) => s + parseFloat(e.total_revenue), 0);

    const ranking = employees.map((emp, index) => {
      const revenue = parseFloat(emp.total_revenue) || 0;
      const prevRevenue = parseFloat(emp.prev_revenue) || 0;
      const trend = prevRevenue > 0
        ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100)
        : (revenue > 0 ? 100 : 0);

      return {
        position: index + 1,
        id: emp.id,
        full_name: emp.full_name,
        job_role: emp.job_role,
        total_sales: parseInt(emp.total_sales) || 0,
        total_revenue: revenue,
        avg_ticket: parseFloat(emp.avg_ticket) || 0,
        trend_pct: trend, // BE-REV-04: trend vs previous period
        share_pct: totalRevenue > 0
          ? parseFloat(((revenue / totalRevenue) * 100).toFixed(1))
          : 0,
        is_top: index === 0,
        medal: index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : null,
      };
    });

    res.json({
      period: { start: startDate, end: endDate, label: period },
      total_revenue: totalRevenue,
      total_employees: ranking.length,
      ranking,
      employee_of_month: ranking[0] || null,
    });

  } catch (err) {
    console.error('Erro em GET /employees/ranking:', err.message);
    res.status(500).json({ error: 'Erro ao buscar ranking de funcionários' });
  }
});

module.exports = router;
