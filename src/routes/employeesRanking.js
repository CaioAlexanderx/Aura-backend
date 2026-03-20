// ============================================================
// AURA. — Ranking de Funcionários / Funcionário do Mês (BE-02)
// ============================================================

const express = require('express');
const router  = express.Router({ mergeParams: true });
const { getTopEmployees, resolvePeriod } = require('../services/salesAnalytics');
const db = require('../config/database');

const VALID_PERIODS = ['week', 'month', 'year', 'custom'];

/**
 * GET /companies/:id/employees/ranking
 * Query params:
 *   period     = week | month | year | custom  (padrão: month)
 *   start_date = YYYY-MM-DD (apenas se period=custom)
 *   end_date   = YYYY-MM-DD (apenas se period=custom)
 */
router.get('/', async (req, res) => {
  try {
    const companyId = req.params.id;
    const { period = 'month', start_date, end_date } = req.query;

    if (!VALID_PERIODS.includes(period)) {
      return res.status(400).json({
        error: `period inválido. Use: ${VALID_PERIODS.join(', ')}`,
      });
    }

    if (period === 'custom' && (!start_date || !end_date)) {
      return res.status(400).json({
        error: 'Para period=custom, informe start_date e end_date (YYYY-MM-DD)',
      });
    }

    const { startDate, endDate } = resolvePeriod(period, start_date, end_date);

    // Ranking de vendas com posição
    const employees = await getTopEmployees(companyId, startDate, endDate);

    // Buscar total do período para calcular % de participação
    const { rows: totalRows } = await db.query(`
      SELECT COALESCE(SUM(total_amount), 0) AS total
      FROM sales
      WHERE company_id = $1
        AND created_at >= $2
        AND created_at < $3
    `, [companyId, startDate, endDate]);

    const totalRevenue = parseFloat(totalRows[0].total);

    const ranking = employees.map((emp, index) => ({
      position:       index + 1,
      id:             emp.id,
      full_name:      emp.full_name,
      total_sales:    emp.total_sales,
      total_revenue:  emp.total_revenue,
      avg_ticket:     emp.avg_ticket,
      share_pct:      totalRevenue > 0
        ? parseFloat(((emp.total_revenue / totalRevenue) * 100).toFixed(1))
        : 0,
      is_top:         index === 0,  // funcionário do mês
    }));

    res.json({
      period: { start: startDate, end: endDate, label: period },
      total_revenue: totalRevenue,
      ranking,
      employee_of_month: ranking[0] || null,
    });

  } catch (err) {
    console.error('Erro em GET /employees/ranking:', err.message);
    res.status(500).json({ error: 'Erro ao buscar ranking de funcionários' });
  }
});

module.exports = router;
