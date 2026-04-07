// ============================================================
// AURA. — PERF-01: Aggregated Dashboard Endpoint
// GET /companies/:id/dashboard
// Returns ALL dashboard data in 1 request instead of 2-3
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// GET /companies/:id/dashboard
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const [summaryRes, recentRes, sparkRes, obligationsRes] = await Promise.all([
      // 1. Monthly summary
      db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS expenses,
           COUNT(CASE WHEN type='income' THEN 1 END) AS income_count,
           COUNT(*) AS total_count
         FROM transactions
         WHERE company_id = $1
           AND created_at >= date_trunc('month', CURRENT_DATE)
           AND created_at < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'`,
        [cid]
      ),
      // 2. Recent sales (last 5) — only columns that exist
      db.query(
        `SELECT id, description, amount, type, created_at
         FROM transactions
         WHERE company_id = $1 AND type = 'income'
         ORDER BY created_at DESC LIMIT 5`,
        [cid]
      ),
      // 3. Sparkline (last 7 days revenue + expenses)
      db.query(
        `SELECT
           d.day::date AS date,
           COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END), 0) AS expenses
         FROM generate_series(
           CURRENT_DATE - INTERVAL '6 days',
           CURRENT_DATE,
           '1 day'
         ) AS d(day)
         LEFT JOIN transactions t
           ON t.company_id = $1
           AND t.created_at::date = d.day::date
         GROUP BY d.day
         ORDER BY d.day ASC`,
        [cid]
      ),
      // 4. Upcoming obligations (next 30 days)
      db.query(
        `SELECT id, name, due_date, estimated_amount, status, category
         FROM fiscal_obligations
         WHERE company_id = $1
           AND due_date >= CURRENT_DATE
           AND due_date <= CURRENT_DATE + INTERVAL '30 days'
         ORDER BY due_date ASC
         LIMIT 5`,
        [cid]
      ).catch(() => ({ rows: [] })),
    ]);

    const summary = summaryRes.rows[0] || {};
    const revenue = parseFloat(summary.revenue) || 0;
    const expenses = parseFloat(summary.expenses) || 0;
    const net = revenue - expenses;

    // Previous month for delta comparison
    let prevRevenue = 0;
    let prevExpenses = 0;
    try {
      const prevRes = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END), 0) AS expenses
         FROM transactions
         WHERE company_id = $1
           AND created_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '1 month'
           AND created_at < date_trunc('month', CURRENT_DATE)`,
        [cid]
      );
      prevRevenue = parseFloat(prevRes.rows[0]?.revenue) || 0;
      prevExpenses = parseFloat(prevRes.rows[0]?.expenses) || 0;
    } catch (_) {}

    const revenueDelta = prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : 0;
    const expensesDelta = prevExpenses > 0 ? Math.round(((expenses - prevExpenses) / prevExpenses) * 100) : 0;
    const netDelta = (prevRevenue - prevExpenses) > 0
      ? Math.round(((net - (prevRevenue - prevExpenses)) / (prevRevenue - prevExpenses)) * 100)
      : 0;

    // Today's sales
    let salesToday = 0;
    try {
      const todayRes = await db.query(
        `SELECT COALESCE(SUM(amount), 0) AS total
         FROM transactions
         WHERE company_id = $1 AND type = 'income'
           AND created_at::date = CURRENT_DATE`,
        [cid]
      );
      salesToday = parseFloat(todayRes.rows[0]?.total) || 0;
    } catch (_) {}

    // New customers this month
    let newCustomers = 0;
    try {
      const custRes = await db.query(
        `SELECT COUNT(*) AS cnt FROM customers
         WHERE company_id = $1
           AND created_at >= date_trunc('month', CURRENT_DATE)`,
        [cid]
      );
      newCustomers = parseInt(custRes.rows[0]?.cnt) || 0;
    } catch (_) {}

    const sparkline = sparkRes.rows.map(r => ({
      date: r.date,
      revenue: parseFloat(r.revenue) || 0,
      expenses: parseFloat(r.expenses) || 0,
      net: (parseFloat(r.revenue) || 0) - (parseFloat(r.expenses) || 0),
    }));

    const avgTicket = parseInt(summary.income_count) > 0
      ? revenue / parseInt(summary.income_count)
      : 0;

    res.json({
      revenue,
      expenses,
      net,
      salesToday,
      avgTicket: Math.round(avgTicket * 100) / 100,
      newCustomers,
      revenueDelta,
      expensesDelta,
      netDelta,
      sparkRevenue: sparkline.map(s => s.revenue),
      sparkExpenses: sparkline.map(s => s.expenses),
      sparkNet: sparkline.map(s => s.net),
      recentSales: recentRes.rows.map(r => ({
        id: r.id,
        customer: r.description || 'Venda',
        amount: parseFloat(r.amount) || 0,
        time: r.created_at ? new Date(r.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--',
        method: 'Pix',
      })),
      obligations: obligationsRes.rows.map(r => ({
        id: r.id,
        name: r.name,
        due: r.due_date ? new Date(r.due_date).toLocaleDateString('pt-BR') : '',
        amount: r.estimated_amount ? parseFloat(r.estimated_amount) : null,
        status: r.status || 'pending',
        category: r.category || 'aura_resolve',
      })),
    });
  } catch (err) {
    console.error('dashboard aggregate error:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

module.exports = router;
