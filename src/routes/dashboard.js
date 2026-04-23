// ============================================================
// AURA. — PERF-01: Aggregated Dashboard Endpoint
// GET /companies/:id/dashboard
// Returns ALL dashboard data in 1 request instead of 2-3
//
// TIMEZONE FIX: todas as agregacoes por data usam SP (America/Sao_Paulo).
// DB roda em UTC — CURRENT_DATE retornaria dia errado apos 21h BRT.
//
// SEMANTIC FIX 23/04:
//   - revenue/expenses/saldo somam APENAS status='confirmed' (ja entrou/saiu caixa).
//     Antes somava pending+cancelled junto => valores infladissimos no dashboard.
//   - salesToday consulta tabela 'sales' (PDV), nao 'transactions'.
//   - avg_ticket calculado sobre sales, nao transactions.
//   - Expose pendingIncome/pendingExpenses como info separada (nao entram no saldo).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// GET /companies/:id/dashboard
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const [summaryRes, recentRes, sparkRes, obligationsRes] = await Promise.all([
      // 1. Monthly summary — SP timezone, APENAS confirmed (realizado)
      db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income'  AND status='confirmed' THEN amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN type='expense' AND status='confirmed' THEN amount ELSE 0 END), 0) AS expenses,
           COALESCE(SUM(CASE WHEN type='income'  AND status='pending'   THEN amount ELSE 0 END), 0) AS pending_income,
           COALESCE(SUM(CASE WHEN type='expense' AND status='pending'   THEN amount ELSE 0 END), 0) AS pending_expenses,
           COUNT(CASE WHEN type='income' AND status='confirmed' THEN 1 END) AS income_count_confirmed
         FROM transactions
         WHERE company_id = $1
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'`,
        [cid]
      ),
      // 2. Recent sales (last 5) — APENAS confirmed (transactions, compatibilidade FE)
      db.query(
        `SELECT id, description, amount, type, created_at
         FROM transactions
         WHERE company_id = $1 AND type = 'income' AND status = 'confirmed'
         ORDER BY created_at DESC LIMIT 5`,
        [cid]
      ),
      // 3. Sparkline (last 7 days revenue + expenses) — SP timezone, apenas confirmed
      db.query(
        `SELECT
           d.day::date AS date,
           COALESCE(SUM(CASE WHEN t.type='income'  THEN t.amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END), 0) AS expenses
         FROM generate_series(
           (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '6 days',
           (NOW() AT TIME ZONE 'America/Sao_Paulo')::date,
           '1 day'
         ) AS d(day)
         LEFT JOIN transactions t
           ON t.company_id = $1
           AND t.status = 'confirmed'
           AND (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date = d.day::date
         GROUP BY d.day
         ORDER BY d.day ASC`,
        [cid]
      ),
      // 4. Upcoming obligations (next 30 days)
      db.query(
        `SELECT id, name, due_date, estimated_amount, status, category
         FROM fiscal_obligations
         WHERE company_id = $1
           AND due_date >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
           AND due_date <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '30 days'
         ORDER BY due_date ASC
         LIMIT 5`,
        [cid]
      ).catch(() => ({ rows: [] })),
    ]);

    const summary = summaryRes.rows[0] || {};
    const revenue = parseFloat(summary.revenue) || 0;
    const expenses = parseFloat(summary.expenses) || 0;
    const pendingIncome   = parseFloat(summary.pending_income)   || 0;
    const pendingExpenses = parseFloat(summary.pending_expenses) || 0;
    const net = revenue - expenses;

    // Previous month for delta comparison — SP timezone, apenas confirmed
    let prevRevenue = 0;
    let prevExpenses = 0;
    try {
      const prevRes = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income'  AND status='confirmed' THEN amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN type='expense' AND status='confirmed' THEN amount ELSE 0 END), 0) AS expenses
         FROM transactions
         WHERE company_id = $1
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) - INTERVAL '1 month'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))`,
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

    // Today's sales — fonte: tabela sales (PDV), nao transactions.
    // Dashboard "vendas hoje" deve refletir o caixa da loja, nao contas a receber.
    let salesToday = 0;
    let salesCountToday = 0;
    let avgTicket = 0;
    let salesCountMonth = 0;
    try {
      const salesRes = await db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN total_amount ELSE 0 END), 0) AS today_total,
           COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date) AS today_count,
           COALESCE(SUM(total_amount), 0) AS month_total,
           COUNT(*) AS month_count
         FROM sales
         WHERE company_id = $1
           AND status != 'cancelled'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'`,
        [cid]
      );
      salesToday      = parseFloat(salesRes.rows[0]?.today_total)  || 0;
      salesCountToday = parseInt(salesRes.rows[0]?.today_count)    || 0;
      const monthTotal = parseFloat(salesRes.rows[0]?.month_total) || 0;
      salesCountMonth = parseInt(salesRes.rows[0]?.month_count)    || 0;
      avgTicket = salesCountMonth > 0 ? monthTotal / salesCountMonth : 0;
    } catch (_) {}

    // New customers this month — SP timezone
    let newCustomers = 0;
    try {
      const custRes = await db.query(
        `SELECT COUNT(*) AS cnt FROM customers
         WHERE company_id = $1
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))`,
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

    res.json({
      revenue,
      expenses,
      net,
      pendingIncome,
      pendingExpenses,
      salesToday,
      salesCountToday,
      salesCountMonth,
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
        time: r.created_at ? new Date(r.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '--:--',
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
