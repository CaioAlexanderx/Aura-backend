// ============================================================
// AURA. — BE-REV-02: Dashboard Sparkline Endpoint
// GET /companies/:id/dashboard/sparkline?days=7
// Returns daily revenue/expenses/net for sparkline charts
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

router.get('/', async (req, res) => {
  const cid = req.params.id;
  const days = Math.min(Math.max(parseInt(req.query.days) || 7, 2), 90);

  try {
    const { rows } = await db.query(
      `SELECT
         d.day::date AS date,
         COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END), 0) AS revenue,
         COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END), 0) AS expenses
       FROM generate_series(
         CURRENT_DATE - ($2 - 1) * INTERVAL '1 day',
         CURRENT_DATE,
         '1 day'
       ) AS d(day)
       LEFT JOIN transactions t
         ON t.company_id = $1
         AND t.created_at::date = d.day::date
       GROUP BY d.day
       ORDER BY d.day ASC`,
      [cid, days]
    );

    const sparkline = rows.map(r => ({
      date: r.date,
      revenue: parseFloat(r.revenue) || 0,
      expenses: parseFloat(r.expenses) || 0,
      net: (parseFloat(r.revenue) || 0) - (parseFloat(r.expenses) || 0),
    }));

    res.json({
      days,
      sparkline,
      revenue: sparkline.map(s => s.revenue),
      expenses: sparkline.map(s => s.expenses),
      net: sparkline.map(s => s.net),
    });
  } catch (err) {
    console.error('sparkline error:', err);
    res.status(500).json({ error: 'Erro ao gerar sparkline' });
  }
});

module.exports = router;
