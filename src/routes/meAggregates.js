// ============================================================
// AURA. — Multi-CNPJ Sessao 2: endpoints /me/* consolidados
//
// Estes endpoints agregam dados de TODAS as empresas do user.
// Sao chamados pelo frontend quando consolidatedView=true (modo
// "Todas as empresas" no switcher).
//
// Onda 2.1 (atual): /me/dashboard — KPIs somados + breakdown.
// Proximas ondas (Sessao 2):
//   2.2: /me/transactions, /me/financial/summary
//   2.3: /me/customers (com customer_group_id pra dedup)
//   2.4: /me/sales
//   2.5: /me/appointments
//
// Convencoes:
// - Todas as queries filtram por `company_id = ANY($1)` onde $1
//   e o array de empresas que o user tem acesso (permissive:
//   c.owner_id OR cm.user_id).
// - Timezone Brasil (America/Sao_Paulo) consistente com
//   /companies/:id/dashboard original.
// - Shape do response = mesma do endpoint per-company + campo
//   `breakdown` com array por empresa (pra UI mostrar split).
// ============================================================
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');

router.use(requireAuth);

// ──────────────────────────────────────────────────────────
// Helper: lista IDs e nomes das empresas que o user tem acesso
// (owner OU member ativo). Permissive query — mesma logica de
// /auth/companies. Retorna array vazio se user nao tem nenhuma.
// ──────────────────────────────────────────────────────────
async function getUserCompanies(userId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id)
            c.id, c.legal_name, c.trade_name, c.is_primary, c.created_at
       FROM companies c
       LEFT JOIN company_members cm
         ON cm.company_id = c.id
        AND cm.user_id = $1
        AND cm.status = 'active'
        AND cm.is_active = true
      WHERE (c.owner_id = $1 OR cm.user_id = $1)
        AND c.is_active = true
      ORDER BY c.id, c.is_primary DESC NULLS LAST, c.created_at ASC`,
    [userId]
  );
  // Re-ordena pra primary first
  rows.sort((a, b) => {
    if (a.is_primary && !b.is_primary) return -1;
    if (!a.is_primary && b.is_primary) return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return rows;
}

function emptyDashboardResponse() {
  return {
    revenue: 0, salesCountMonth: 0, avgTicket: 0,
    salesToday: 0, salesCountToday: 0, revenueDelta: 0,
    cashInflow: 0, expenses: 0, net: 0,
    pendingIncome: 0, pendingExpenses: 0,
    expensesDelta: 0, netDelta: 0,
    newCustomers: 0,
    sparkRevenue: [0,0,0,0,0,0,0],
    sparkExpenses: [0,0,0,0,0,0,0],
    sparkNet: [0,0,0,0,0,0,0],
    recentSales: [],
    obligations: [],
    breakdown: [],
    company_count: 0,
  };
}

// ──────────────────────────────────────────────────────────
// GET /me/dashboard — Onda 2.1
//
// Mesma shape do /companies/:id/dashboard + `breakdown[]` com
// totais por empresa.
//
// Performance: 7 queries em paralelo, todas com company_id = ANY($1).
// Pra Davi (2 empresas) = ~mesma latencia do per-company (1 round-trip
// agregado por consulta). Escala linear ate ~50 empresas — depois
// pode precisar de indices ou cache.
// ──────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const userId = req.user.id;
    const companies = await getUserCompanies(userId);

    if (companies.length === 0) {
      return res.json(emptyDashboardResponse());
    }

    const companyIds = companies.map(c => c.id);
    const companyNameById = new Map(
      companies.map(c => [c.id, c.trade_name || c.legal_name || 'Empresa'])
    );

    // Todas as queries em paralelo
    const [
      breakdownTxRes,
      prevTxRes,
      sparkRes,
      recentRes,
      obligationsRes,
      customersRes,
      breakdownSalesRes,
    ] = await Promise.all([
      // 1. BREAKDOWN: cash flow do mes corrente, agrupado por company_id.
      //    Quando o frontend mostrar "Loja A: R$ X", esse e o numero.
      db.query(
        `SELECT company_id,
                COALESCE(SUM(CASE WHEN type='income'  AND status='confirmed' THEN amount ELSE 0 END), 0) AS cash_inflow,
                COALESCE(SUM(CASE WHEN type='expense' AND status='confirmed' THEN amount ELSE 0 END), 0) AS cash_expenses,
                COALESCE(SUM(CASE WHEN type='income'  AND status='pending'   THEN amount ELSE 0 END), 0) AS pending_income,
                COALESCE(SUM(CASE WHEN type='expense' AND status='pending'   THEN amount ELSE 0 END), 0) AS pending_expenses
           FROM transactions
          WHERE company_id = ANY($1)
            AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))::date
            AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  (date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month')::date
          GROUP BY company_id`,
        [companyIds]
      ),

      // 2. Receita do mes ANTERIOR (total) — pra revenueDelta.
      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS prev_income
           FROM transactions
          WHERE company_id = ANY($1)
            AND type = 'income' AND status = 'confirmed'
            AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= (date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) - INTERVAL '1 month')::date
            AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))::date`,
        [companyIds]
      ),

      // 3. Sparkline 7 dias (TOTAL agregado de todas empresas).
      db.query(
        `SELECT d.day::date AS date,
                COALESCE(SUM(CASE WHEN t.type='income'  AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS revenue,
                COALESCE(SUM(CASE WHEN t.type='expense' AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS expenses
           FROM generate_series(
             (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '6 days',
             (NOW() AT TIME ZONE 'America/Sao_Paulo')::date,
             '1 day'
           ) AS d(day)
           LEFT JOIN transactions t
             ON t.company_id = ANY($1)
            AND t.status = 'confirmed'
            AND COALESCE(t.due_date, (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date) = d.day::date
          GROUP BY d.day
          ORDER BY d.day ASC`,
        [companyIds]
      ),

      // 4. 5 entradas mais recentes do conjunto, com company_id pra UI mostrar de qual loja.
      db.query(
        `SELECT t.id, t.description, t.amount, t.type, t.created_at, t.company_id
           FROM transactions t
          WHERE t.company_id = ANY($1)
            AND t.type = 'income' AND t.status = 'confirmed'
          ORDER BY t.created_at DESC LIMIT 5`,
        [companyIds]
      ),

      // 5. Obrigacoes fiscais proximas (30 dias) — 5 mais cedo do conjunto.
      db.query(
        `SELECT id, name, due_date, estimated_amount, status, category, company_id
           FROM fiscal_obligations
          WHERE company_id = ANY($1)
            AND due_date >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
            AND due_date <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '30 days'
          ORDER BY due_date ASC LIMIT 5`,
        [companyIds]
      ).catch(() => ({ rows: [] })),

      // 6. Clientes novos no mes (TOTAL — soma de cadastros recentes).
      //    Nota: pode ter duplicatas entre empresas. Onda 2.3 vai resolver
      //    com customer_group_id; por ora, soma simples.
      db.query(
        `SELECT COUNT(*)::int AS cnt FROM customers
          WHERE company_id = ANY($1)
            AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))`,
        [companyIds]
      ).catch(() => ({ rows: [{ cnt: 0 }] })),

      // 7. Sales count + today por empresa (pra avgTicket e cards de Hoje).
      db.query(
        `SELECT company_id,
                COUNT(*)::int AS month_count,
                COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today_count,
                COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN total_amount ELSE 0 END), 0) AS today_total
           FROM sales
          WHERE company_id = ANY($1)
            AND COALESCE(status, 'completed') != 'cancelled'
            AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
            AND (created_at AT TIME ZONE 'America/Sao_Paulo') <  date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'
          GROUP BY company_id`,
        [companyIds]
      ).catch(() => ({ rows: [] })),
    ]);

    // ── Agrega TX (cash flow) e monta breakdown ──
    let cashInflow = 0, expenses = 0, pendingIncome = 0, pendingExpenses = 0;
    const txMap = new Map(breakdownTxRes.rows.map(r => [r.company_id, r]));
    const salesMap = new Map(breakdownSalesRes.rows.map(r => [r.company_id, r]));

    let salesCountMonth = 0;
    let salesToday = 0;
    let salesCountToday = 0;

    const breakdown = companies.map(c => {
      const tx = txMap.get(c.id) || {};
      const sl = salesMap.get(c.id) || {};
      const inflow = parseFloat(tx.cash_inflow) || 0;
      const exp = parseFloat(tx.cash_expenses) || 0;
      const pi = parseFloat(tx.pending_income) || 0;
      const pe = parseFloat(tx.pending_expenses) || 0;
      const sCountMonth = parseInt(sl.month_count) || 0;
      const sCountToday = parseInt(sl.today_count) || 0;
      const sToday = parseFloat(sl.today_total) || 0;

      cashInflow += inflow;
      expenses += exp;
      pendingIncome += pi;
      pendingExpenses += pe;
      salesCountMonth += sCountMonth;
      salesToday += sToday;
      salesCountToday += sCountToday;

      return {
        company_id: c.id,
        company_name: c.trade_name || c.legal_name || 'Empresa',
        is_primary: c.is_primary,
        revenue: inflow,
        expenses: exp,
        net: inflow - exp,
        pending_income: pi,
        pending_expenses: pe,
        sales_count_month: sCountMonth,
        sales_today: sToday,
      };
    });

    const revenue = cashInflow;
    const net = cashInflow - expenses;

    // Delta vs mes anterior (total)
    const prevIncome = parseFloat(prevTxRes.rows[0]?.prev_income) || 0;
    const revenueDelta = prevIncome > 0
      ? Math.round(((revenue - prevIncome) / prevIncome) * 100)
      : 0;

    const avgTicket = salesCountMonth > 0
      ? Math.round((revenue / salesCountMonth) * 100) / 100
      : 0;

    const newCustomers = parseInt(customersRes.rows[0]?.cnt) || 0;

    const sparkline = sparkRes.rows.map(r => ({
      date: r.date,
      revenue: parseFloat(r.revenue) || 0,
      expenses: parseFloat(r.expenses) || 0,
      net: (parseFloat(r.revenue) || 0) - (parseFloat(r.expenses) || 0),
    }));

    res.json({
      // --- Receita (mesma shape do /companies/:id/dashboard) ---
      revenue,
      salesCountMonth,
      avgTicket,
      salesToday,
      salesCountToday,
      revenueDelta,

      // --- Fluxo de caixa ---
      cashInflow,
      expenses,
      net,
      pendingIncome,
      pendingExpenses,
      expensesDelta: 0,
      netDelta: 0,

      // --- Outros ---
      newCustomers,
      sparkRevenue: sparkline.map(s => s.revenue),
      sparkExpenses: sparkline.map(s => s.expenses),
      sparkNet: sparkline.map(s => s.net),
      recentSales: recentRes.rows.map(r => ({
        id: r.id,
        customer: r.description || 'Venda',
        amount: parseFloat(r.amount) || 0,
        time: r.created_at
          ? new Date(r.created_at).toLocaleTimeString('pt-BR', {
              hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo'
            })
          : '--:--',
        method: 'Pix',
        // EXTRA pro modo consolidado: nome da empresa
        company_id: r.company_id,
        company_name: companyNameById.get(r.company_id) || 'Empresa',
      })),
      obligations: obligationsRes.rows.map(r => ({
        id: r.id,
        name: r.name,
        due: r.due_date ? new Date(r.due_date).toLocaleDateString('pt-BR') : '',
        amount: r.estimated_amount ? parseFloat(r.estimated_amount) : null,
        status: r.status || 'pending',
        category: r.category || 'aura_resolve',
        company_id: r.company_id,
        company_name: companyNameById.get(r.company_id) || 'Empresa',
      })),

      // --- Multi-CNPJ ---
      breakdown,
      company_count: companies.length,
    });
  } catch (err) {
    console.error('[meAggregates] /dashboard error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao carregar painel consolidado' });
  }
});

module.exports = router;
