// ============================================================
// AURA. — PERF-01: Aggregated Dashboard Endpoint
// GET /companies/:id/dashboard
//
// TIMEZONE FIX: todas as agregacoes por data usam SP (America/Sao_Paulo).
// DB roda em UTC — CURRENT_DATE retornaria dia errado apos 21h BRT.
//
// FONTE DE RECEITA (revisao 27/04):
//   revenue = cashInflow = SUM(transactions WHERE type=income AND status=confirmed)
//
//   Motivo: a tabela 'sales' contem entradas invalidas/de-teste que inflam o
//   total. A tabela 'transactions' e a fonte financeira correta — todas as
//   income transactions ja possuem idempotency_key 'pdv-sale-*', provando
//   que 100% das receitas sao originadas do PDV sem gap real.
//
//   Impacto: Dashboard, Financeiro e DRE agora mostram o mesmo valor.
//   A tela de Vendas (salesAnalytics) continua usando 'sales' para
//   metricas operacionais (top produtos, por funcionario, etc.).
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// GET /companies/:id/dashboard
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const [salesCountRes, prevTxRes, cashFlowRes, recentRes, sparkRes, obligationsRes] = await Promise.all([

      // 1. Contagem de vendas do mes e de hoje — sem somar valor.
      //    O valor financeiro vem de transactions (cashInflow), nao de sales.
      db.query(
        `SELECT
           COUNT(*)::int AS month_count,
           COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN total_amount ELSE 0 END), 0) AS today_total,
           COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today_count
         FROM sales
         WHERE company_id = $1
           AND COALESCE(status, 'completed') != 'cancelled'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'`,
        [cid]
      ),

      // 2. Income do mes anterior (transactions) — para revenueDelta
      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS prev_income
         FROM transactions
         WHERE company_id = $1
           AND type = 'income'
           AND status = 'confirmed'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) - INTERVAL '1 month'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))`,
        [cid]
      ),

      // 3. Fluxo de caixa do mes atual (transactions) — fonte principal de receita e despesa
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

      // 4. Ultimas 5 entradas confirmadas
      db.query(
        `SELECT id, description, amount, type, created_at
         FROM transactions
         WHERE company_id = $1 AND type = 'income' AND status = 'confirmed'
         ORDER BY created_at DESC LIMIT 5`,
        [cid]
      ),

      // 5. Sparkline ultimos 7 dias — income e despesas de transactions
      db.query(
        `SELECT
           d.day::date AS date,
           COALESCE(SUM(CASE WHEN t.type='income'  AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS revenue,
           COALESCE(SUM(CASE WHEN t.type='expense' AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS expenses
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

      // 6. Obrigacoes fiscais proximas (30 dias)
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

    // --- Receita: fonte = transactions confirmed (igual ao Financeiro) ---
    const cfRow           = cashFlowRes.rows[0] || {};
    const cashInflow      = parseFloat(cfRow.cash_inflow)       || 0;
    const expenses        = parseFloat(cfRow.cash_expenses)     || 0;
    const pendingIncome   = parseFloat(cfRow.pending_income)    || 0;
    const pendingExpenses = parseFloat(cfRow.pending_expenses)  || 0;
    const net             = cashInflow - expenses;

    // revenue = cashInflow (transactions) — alinhado com Financeiro
    const revenue         = cashInflow;

    // Delta vs mes anterior (transactions)
    const prevIncome      = parseFloat(prevTxRes.rows[0]?.prev_income) || 0;
    const revenueDelta    = prevIncome > 0 ? Math.round(((revenue - prevIncome) / prevIncome) * 100) : 0;

    // Contagem de sales para avgTicket e hoje
    const cntRow          = salesCountRes.rows[0] || {};
    const salesCount      = parseInt(cntRow.month_count)    || 0;
    const salesToday      = parseFloat(cntRow.today_total)  || 0;
    const salesCountToday = parseInt(cntRow.today_count)    || 0;
    const avgTicket       = salesCount > 0 ? Math.round((revenue / salesCount) * 100) / 100 : 0;

    const expensesDelta = 0;
    const netDelta      = 0;

    // Clientes novos no mes
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
      // --- Receita (fonte: transactions confirmed) — igual ao Financeiro ---
      revenue,
      salesCountMonth: salesCount,
      avgTicket,
      salesToday,
      salesCountToday,
      revenueDelta,

      // --- Fluxo de caixa (fonte: transactions) ---
      cashInflow,
      expenses,
      net,
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
