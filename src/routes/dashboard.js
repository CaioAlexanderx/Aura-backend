// ============================================================
// AURA. — PERF-01: Aggregated Dashboard Endpoint
// GET /companies/:id/dashboard
// Returns ALL dashboard data in 1 request instead of 2-3
//
// TIMEZONE FIX: todas as agregacoes por data usam SP (America/Sao_Paulo).
// DB roda em UTC — CURRENT_DATE retornaria dia errado apos 21h BRT.
//
// UNIFICACAO 27/04:
//   - revenue agora vem da tabela 'sales' (status != 'cancelled'),
//     igual ao endpoint /vendas e /folha. Isso elimina a divergencia de
//     valores entre telas para o mesmo periodo.
//   - cashInflow (transactions confirmed) exposto separadamente para o
//     modulo Financeiro, que mostra fluxo de caixa realizado.
//   - avgTicket calculado sobre o mesmo universo de sales.
//   - revenueDelta compara sales do mes atual vs mes anterior.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// GET /companies/:id/dashboard
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const [salesSummaryRes, prevSalesRes, cashFlowRes, recentRes, sparkRes, obligationsRes] = await Promise.all([
      // 1. Faturamento do mes — fonte: tabela sales (igual a /vendas e /folha)
      //    Exclui apenas canceladas; inclui pendentes e confirmadas.
      db.query(
        `SELECT
           COALESCE(SUM(total_amount), 0)     AS month_total,
           COUNT(*)::int                       AS month_count,
           COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN total_amount ELSE 0 END), 0) AS today_total,
           COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today_count
         FROM sales
         WHERE company_id = $1
           AND status != 'cancelled'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'`,
        [cid]
      ),
      // 2. Faturamento mes anterior (sales) — para calculo do delta
      db.query(
        `SELECT
           COALESCE(SUM(total_amount), 0) AS prev_total
         FROM sales
         WHERE company_id = $1
           AND status != 'cancelled'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) - INTERVAL '1 month'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))`,
        [cid]
      ),
      // 3. Fluxo de caixa (transactions) — exposto como cashInflow/cashExpenses
      //    Usado pelo modulo Financeiro. Nao e mais o revenue principal do dashboard.
      db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income'  AND status='confirmed' THEN amount ELSE 0 END), 0) AS cash_inflow,
           COALESCE(SUM(CASE WHEN type='expense' AND status='confirmed' THEN amount ELSE 0 END), 0) AS cash_expenses,
           COALESCE(SUM(CASE WHEN type='income'  AND status='pending'   THEN amount ELSE 0 END), 0) AS pending_income,
           COALESCE(SUM(CASE WHEN type='expense' AND status='pending'   THEN amount ELSE 0 END), 0) AS pending_expenses
         FROM transactions
         WHERE company_id = $1
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'`,
        [cid]
      ),
      // 4. Recent sales (last 5) — transactions confirmed
      db.query(
        `SELECT id, description, amount, type, created_at
         FROM transactions
         WHERE company_id = $1 AND type = 'income' AND status = 'confirmed'
         ORDER BY created_at DESC LIMIT 5`,
        [cid]
      ),
      // 5. Sparkline (last 7 days revenue + expenses) — fonte: sales para receita, transactions para despesas
      db.query(
        `SELECT
           d.day::date AS date,
           COALESCE(SUM(s.total_amount), 0)                                                         AS revenue,
           COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END), 0)                   AS expenses
         FROM generate_series(
           (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '6 days',
           (NOW() AT TIME ZONE 'America/Sao_Paulo')::date,
           '1 day'
         ) AS d(day)
         LEFT JOIN sales s
           ON s.company_id = $1
           AND s.status != 'cancelled'
           AND (s.created_at AT TIME ZONE 'America/Sao_Paulo')::date = d.day::date
         LEFT JOIN transactions t
           ON t.company_id = $1
           AND t.status = 'confirmed'
           AND t.type = 'expense'
           AND (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date = d.day::date
         GROUP BY d.day
         ORDER BY d.day ASC`,
        [cid]
      ),
      // 6. Upcoming obligations (next 30 days)
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

    // --- Faturamento (sales) ---
    const salesRow      = salesSummaryRes.rows[0] || {};
    const revenue       = parseFloat(salesRow.month_total)  || 0;  // fonte unica: sales
    const salesCount    = parseInt(salesRow.month_count)    || 0;
    const salesToday    = parseFloat(salesRow.today_total)  || 0;
    const salesCountToday = parseInt(salesRow.today_count)  || 0;
    const avgTicket     = salesCount > 0 ? Math.round((revenue / salesCount) * 100) / 100 : 0;

    // Delta vs mes anterior (sales)
    const prevRevenue   = parseFloat(prevSalesRes.rows[0]?.prev_total) || 0;
    const revenueDelta  = prevRevenue > 0 ? Math.round(((revenue - prevRevenue) / prevRevenue) * 100) : 0;

    // --- Fluxo de caixa (transactions) ---
    const cfRow         = cashFlowRes.rows[0] || {};
    const cashInflow    = parseFloat(cfRow.cash_inflow)    || 0;  // confirmado recebido
    const expenses      = parseFloat(cfRow.cash_expenses)  || 0;
    const pendingIncome = parseFloat(cfRow.pending_income) || 0;
    const pendingExpenses = parseFloat(cfRow.pending_expenses) || 0;
    const net           = cashInflow - expenses;

    const expensesDelta = 0;  // calculo de delta de despesas pode ser adicionado se necessario
    const netDelta      = 0;

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
      date:     r.date,
      revenue:  parseFloat(r.revenue)  || 0,
      expenses: parseFloat(r.expenses) || 0,
      net:      (parseFloat(r.revenue) || 0) - (parseFloat(r.expenses) || 0),
    }));

    res.json({
      // --- Faturamento (fonte: sales) — mesmo universo de /vendas e /folha ---
      revenue,           // total do mes (sales, status != cancelled)
      salesCountMonth: salesCount,
      avgTicket,
      salesToday,
      salesCountToday,
      revenueDelta,

      // --- Fluxo de caixa (fonte: transactions) — para modulo Financeiro ---
      cashInflow,        // entradas confirmadas
      expenses,          // saidas confirmadas
      net,               // saldo realizado
      pendingIncome,
      pendingExpenses,
      expensesDelta,
      netDelta,

      // --- Outros ---
      newCustomers,
      sparkRevenue:  sparkline.map(s => s.revenue),
      sparkExpenses: sparkline.map(s => s.expenses),
      sparkNet:      sparkline.map(s => s.net),
      recentSales: recentRes.rows.map(r => ({
        id:       r.id,
        customer: r.description || 'Venda',
        amount:   parseFloat(r.amount) || 0,
        time:     r.created_at ? new Date(r.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '--:--',
        method:   'Pix',
      })),
      obligations: obligationsRes.rows.map(r => ({
        id:       r.id,
        name:     r.name,
        due:      r.due_date ? new Date(r.due_date).toLocaleDateString('pt-BR') : '',
        amount:   r.estimated_amount ? parseFloat(r.estimated_amount) : null,
        status:   r.status || 'pending',
        category: r.category || 'aura_resolve',
      })),
    });
  } catch (err) {
    console.error('dashboard aggregate error:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

module.exports = router;
