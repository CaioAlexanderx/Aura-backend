// ============================================================
// AURA. — Ranking de Funcionários + Link PDV (BE-02 + BE-REV-04)
// GET /companies/:id/employees/ranking
// FIX: excludes cancelled sales, timezone SP, unassigned sales
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const db = require('../config/database');

const VALID_PERIODS = ['week', 'month', 'year', 'custom'];
const CANCEL_FILTER = "AND COALESCE(s.status,'completed') != 'cancelled'";

function resolvePeriod(period, startDate, endDate) {
  const now = new Date();
  switch (period) {
    case 'week': {
      const spNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const start = new Date(spNow);
      start.setDate(spNow.getDate() - spNow.getDay());
      start.setHours(0,0,0,0);
      const startUTC = new Date(start.getTime() + 3 * 3600000);
      const endUTC = new Date(startUTC.getTime() + 7 * 86400000);
      return { startDate: startUTC.toISOString(), endDate: endUTC.toISOString() };
    }
    case 'year': {
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 3, 0, 0));
      const end = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1, 3, 0, 0));
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
    case 'custom':
      return { startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString() };
    default: {
      const spNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      const start = new Date(Date.UTC(spNow.getFullYear(), spNow.getMonth(), 1, 3, 0, 0));
      const end = new Date(Date.UTC(spNow.getFullYear(), spNow.getMonth() + 1, 1, 3, 0, 0));
      return { startDate: start.toISOString(), endDate: end.toISOString() };
    }
  }
}

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

    // 1. Employees com vendas vinculadas (exclui canceladas)
    const { rows: employees } = await db.query(`
      SELECT
        e.id,
        e.name AS full_name,
        COALESCE(e.role, e.role_title, 'Vendedor') AS job_role,
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
          ${CANCEL_FILTER}
      ) sales ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(s2.total_amount), 0) AS prev_revenue
        FROM sales s2
        WHERE s2.company_id = $1
          AND s2.employee_id = e.id
          AND s2.created_at >= ($2::timestamptz - ($3::timestamptz - $2::timestamptz))
          AND s2.created_at < $2
          AND COALESCE(s2.status,'completed') != 'cancelled'
      ) prev ON true
      WHERE e.company_id = $1 AND e.is_active = true
      ORDER BY sales.total_revenue DESC NULLS LAST
    `, [companyId, startDate, endDate]);

    // 2. Vendas SEM employee_id (orfas, exclui canceladas)
    const { rows: unassignedRows } = await db.query(`
      SELECT
        COUNT(s.id) AS total_sales,
        COALESCE(SUM(s.total_amount), 0) AS total_revenue
      FROM sales s
      WHERE s.company_id = $1
        AND s.employee_id IS NULL
        AND s.created_at >= $2
        AND s.created_at < $3
        ${CANCEL_FILTER}
    `, [companyId, startDate, endDate]);
    const unassigned = unassignedRows[0] || { total_sales: 0, total_revenue: 0 };
    const unassignedSales = parseInt(unassigned.total_sales) || 0;
    const unassignedRevenue = parseFloat(unassigned.total_revenue) || 0;

    // 3. Total geral
    const employeeTotalRevenue = employees.reduce((s, e) => s + parseFloat(e.total_revenue), 0);
    const totalRevenue = employeeTotalRevenue + unassignedRevenue;
    const employeeTotalSales = employees.reduce((s, e) => s + (parseInt(e.total_sales) || 0), 0);
    const totalSales = employeeTotalSales + unassignedSales;

    // 4. Montar ranking
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
        trend_pct: trend,
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
      total_sales: totalSales,
      total_employees: ranking.length,
      ranking,
      unassigned: unassignedSales > 0 ? {
        total_sales: unassignedSales,
        total_revenue: unassignedRevenue,
        avg_ticket: unassignedSales > 0 ? Math.round((unassignedRevenue / unassignedSales) * 100) / 100 : 0,
        share_pct: totalRevenue > 0 ? parseFloat(((unassignedRevenue / totalRevenue) * 100).toFixed(1)) : 0,
      } : null,
      employee_of_month: ranking[0] || null,
    });

  } catch (err) {
    console.error('Erro em GET /employees/ranking:', err.message);
    res.status(500).json({ error: 'Erro ao buscar ranking de funcionários' });
  }
});

module.exports = router;
