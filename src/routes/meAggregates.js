// ============================================================
// AURA. — Multi-CNPJ Sessao 2: endpoints /me/* consolidados
//
// Estes endpoints agregam dados de TODAS as empresas do user.
// Sao chamados pelo frontend quando consolidatedView=true (modo
// "Todas as empresas" no switcher).
//
// Onda 2.1: /me/dashboard — KPIs somados + breakdown.
// Onda 2.2: /me/transactions — listagem + drill-down via ?company_id=.
// Onda 2.3: /me/customers — lista UNICA owner-scoped.
// Onda 2.4: /me/sales — listagem agregada com stats e breakdown.
// Onda 2.6 (atual): /me/sales/analytics — analytics agregadas
//   (summary/series/top_products/top_employees/by_payment) com
//   breakdown opcional por empresa. Reabilita SalesAnalyticsCard
//   no Painel em modo consolidated.
//
// Convencoes:
// - Todas as queries filtram por `company_id = ANY($1)` onde $1
//   e o array de empresas que o user tem acesso (permissive:
//   c.owner_id OR cm.user_id).
// - Timezone Brasil (America/Sao_Paulo).
// - Shape do response = mesma do endpoint per-company + campo
//   `breakdown` com array por empresa (pra UI mostrar split).
// - Mutations (POST/PATCH/DELETE) NAO existem em /me/* — usuario
//   precisa trocar pra empresa especifica antes de criar/editar.
//
// 09/05/2026 (fonte unica vendas): /sales/analytics agora deriva
//   total_revenue de SALES (mesma fonte do /dashboard salesToday).
//   Antes vinha de transactions confirmed, divergindo do KPI top do
//   Painel — Eryca Finesse viu 7651 vs 7247 na mesma tela.
//
// 11/05/2026 (fix trocas inflando salesToday/analytics):
//   - breakdownSalesRes em /me/dashboard agora exclui type='troca'.
//   - summaryRes, seriesRes, byPaymentRes em /me/sales/analytics
//     tambem excluem type='troca'.
//   Trocas tem total_amount = newValue (produto novo) e nao
//   netAmount real. Mesmo fix aplicado em /dashboard (dashboard.js)
//   e ja estava em /pdv/summary (PR #41 07/05).
//   top_products e top_employees mantidos sem filtro: itens reais
//   vendidos e seller real continuam contando.
//
// 29/05/2026 (type na listagem): /me/sales expoe COALESCE(s.type,'sale')
//   AS type pra UI consolidada marcar "Troca" (igual ao per-company
//   /companies/:id/sales). A troca SEMPRE apareceu na listagem (sem
//   filtro de type); so faltava o campo no retorno. Agregados de receita
//   seguem excluindo troca (analytics/dashboard) — sem mudanca.
// ============================================================
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');
const { resolvePeriod } = require('../services/salesAnalytics');

router.use(requireAuth);

// ──────────────────────────────────────────────────────────
// Helper: lista IDs e nomes das empresas que o user tem acesso
// (owner OU member ativo). Permissive query.
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

function getPlanLimit(plan) {
  switch ((plan || '').toLowerCase()) {
    case 'expansao':
    case 'personalizado': return 999999;
    case 'negocio':       return 5000;
    default:              return 1000;
  }
}

// ──────────────────────────────────────────────────────────
// GET /me/dashboard — Onda 2.1
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

    const [
      breakdownTxRes,
      prevTxRes,
      sparkRes,
      recentRes,
      obligationsRes,
      customersRes,
      breakdownSalesRes,
    ] = await Promise.all([
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

      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS prev_income
           FROM transactions
          WHERE company_id = ANY($1)
            AND type = 'income' AND status = 'confirmed'
            AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= (date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) - INTERVAL '1 month')::date
            AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))::date`,
        [companyIds]
      ),

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

      db.query(
        `SELECT t.id, t.description, t.amount, t.type, t.created_at, t.company_id
           FROM transactions t
          WHERE t.company_id = ANY($1)
            AND t.type = 'income' AND t.status = 'confirmed'
          ORDER BY t.created_at DESC LIMIT 5`,
        [companyIds]
      ),

      db.query(
        `SELECT id, name, due_date, estimated_amount, status, category, company_id
           FROM fiscal_obligations
          WHERE company_id = ANY($1)
            AND due_date >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date
            AND due_date <= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date + INTERVAL '30 days'
          ORDER BY due_date ASC LIMIT 5`,
        [companyIds]
      ).catch(() => ({ rows: [] })),

      db.query(
        `SELECT COUNT(*)::int AS cnt FROM customers
          WHERE company_id = ANY($1)
            AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))`,
        [companyIds]
      ).catch(() => ({ rows: [{ cnt: 0 }] })),

      // 11/05/2026: exclui type='troca' (mesmo fix do dashboard.js per-company).
      // Trocas tem total_amount = newValue inflando salesToday consolidado.
      db.query(
        `SELECT company_id,
                COUNT(*)::int AS month_count,
                COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today_count,
                COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN total_amount ELSE 0 END), 0) AS today_total
           FROM sales
          WHERE company_id = ANY($1)
            AND COALESCE(status, 'completed') != 'cancelled'
            AND COALESCE(type, 'sale') = 'sale'
            AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
            AND (created_at AT TIME ZONE 'America/Sao_Paulo') <  date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'
          GROUP BY company_id`,
        [companyIds]
      ).catch(() => ({ rows: [] })),
    ]);

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
      revenue,
      salesCountMonth,
      avgTicket,
      salesToday,
      salesCountToday,
      revenueDelta,

      cashInflow,
      expenses,
      net,
      pendingIncome,
      pendingExpenses,
      expensesDelta: 0,
      netDelta: 0,

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

      breakdown,
      company_count: companies.length,
    });
  } catch (err) {
    console.error('[meAggregates] /dashboard error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao carregar painel consolidado' });
  }
});

// ──────────────────────────────────────────────────────────
// GET /me/transactions — Onda 2.2
// ──────────────────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const userId = req.user.id;
    const companies = await getUserCompanies(userId);

    if (companies.length === 0) {
      return res.json({
        transactions: [], total: 0,
        limit: parseInt(req.query.limit) || 200,
        offset: parseInt(req.query.offset) || 0,
        summary: { income: 0, expenses: 0, pending_income: 0, pending_expenses: 0 },
        breakdown: [],
        company_count: 0,
        filtered_company_id: null,
      });
    }

    let companyIds = companies.map(c => c.id);
    const filterCompanyId = req.query.company_id || null;

    if (filterCompanyId) {
      if (!companyIds.includes(filterCompanyId)) {
        return res.status(403).json({ error: 'Sem acesso a essa empresa' });
      }
      companyIds = [filterCompanyId];
    }

    const limit = Math.min(parseInt(req.query.limit) || 200, 10000);
    const offset = parseInt(req.query.offset) || 0;
    const type = req.query.type;
    const status = req.query.status;
    const start = req.query.start;
    const end = req.query.end;
    const q = req.query.q;

    const params = [companyIds];
    let where = 'WHERE company_id = ANY($1)';

    if (type === 'income' || type === 'expense') {
      params.push(type);
      where += ' AND type = $' + params.length;
    }
    if (status === 'confirmed' || status === 'pending') {
      params.push(status);
      where += ' AND status = $' + params.length;
    }
    if (start) {
      params.push(start);
      where += ` AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= $${params.length}`;
    }
    if (end) {
      params.push(end);
      where += ` AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= $${params.length}`;
    }
    if (q && String(q).trim()) {
      params.push('%' + String(q).trim() + '%');
      where += ' AND description ILIKE $' + params.length;
    }

    const countQ = await db.query(
      'SELECT COUNT(*) AS total FROM transactions ' + where,
      params
    );

    const dataParams = params.concat([limit, offset]);
    const dataQ = await db.query(
      `SELECT id, type, amount, description, category, status, notes,
              due_date, paid_at, created_at,
              recurrence_type, recurrence_group_id, recurrence_index,
              payment_method, employee_id, employee_name,
              idempotency_key, company_id
         FROM transactions ${where}
        ORDER BY COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC,
                 created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      dataParams
    );

    const sumParams = [companyIds];
    let sumWhere = 'WHERE company_id = ANY($1)';
    if (type === 'income' || type === 'expense') {
      sumParams.push(type);
      sumWhere += ' AND type = $' + sumParams.length;
    }
    if (status === 'confirmed' || status === 'pending') {
      sumParams.push(status);
      sumWhere += ' AND status = $' + sumParams.length;
    }
    if (start) {
      sumParams.push(start);
      sumWhere += ` AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= $${sumParams.length}`;
    }
    if (end) {
      sumParams.push(end);
      sumWhere += ` AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= $${sumParams.length}`;
    }
    if (!start && !end) {
      sumWhere += ` AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))::date`;
      sumWhere += ` AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  (date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month')::date`;
    }

    const sumTotalQ = await db.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE type='income'  AND status='confirmed'), 0) AS income,
         COALESCE(SUM(amount) FILTER (WHERE type='expense' AND status='confirmed'), 0) AS expenses,
         COALESCE(SUM(amount) FILTER (WHERE type='income'  AND status='pending'),   0) AS pending_income,
         COALESCE(SUM(amount) FILTER (WHERE type='expense' AND status='pending'),   0) AS pending_expenses
         FROM transactions ${sumWhere}`,
      sumParams
    );

    const sumByCompanyQ = await db.query(
      `SELECT company_id,
              COALESCE(SUM(amount) FILTER (WHERE type='income'  AND status='confirmed'), 0) AS income,
              COALESCE(SUM(amount) FILTER (WHERE type='expense' AND status='confirmed'), 0) AS expenses,
              COALESCE(SUM(amount) FILTER (WHERE type='income'  AND status='pending'),   0) AS pending_income,
              COALESCE(SUM(amount) FILTER (WHERE type='expense' AND status='pending'),   0) AS pending_expenses
         FROM transactions ${sumWhere}
        GROUP BY company_id`,
      sumParams
    );

    const companyMap = new Map(companies.map(c => [c.id, c]));
    const sumMap = new Map(sumByCompanyQ.rows.map(r => [r.company_id, r]));

    const transactions = dataQ.rows.map(r => {
      const c = companyMap.get(r.company_id);
      return {
        id: r.id,
        type: r.type,
        amount: parseFloat(r.amount) || 0,
        desc: r.description || '',
        description: r.description || '',
        category: r.category || 'Outros',
        status: r.status || 'confirmed',
        notes: r.notes || '',
        date: r.due_date
          ? new Date(r.due_date + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
          : (r.created_at
              ? new Date(r.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })
              : '--/--'),
        due_date: r.due_date,
        paid_at: r.paid_at,
        created_at: r.created_at,
        recurrence_type: r.recurrence_type,
        recurrence_group_id: r.recurrence_group_id,
        recurrence_index: r.recurrence_index,
        payment_method: r.payment_method,
        employee_id: r.employee_id,
        employee_name: r.employee_name,
        idempotency_key: r.idempotency_key,
        source: r.idempotency_key && /^pdv-sale-/i.test(r.idempotency_key) ? 'pdv' : 'manual',
        company_id: r.company_id,
        company_name: c ? (c.trade_name || c.legal_name || 'Empresa') : 'Empresa',
      };
    });

    const breakdownCompanies = filterCompanyId
      ? companies.filter(c => c.id === filterCompanyId)
      : companies;

    const breakdown = breakdownCompanies.map(c => {
      const s = sumMap.get(c.id) || {};
      const income = parseFloat(s.income) || 0;
      const expenses = parseFloat(s.expenses) || 0;
      return {
        company_id: c.id,
        company_name: c.trade_name || c.legal_name || 'Empresa',
        is_primary: c.is_primary,
        income,
        expenses,
        net: income - expenses,
        pending_income: parseFloat(s.pending_income) || 0,
        pending_expenses: parseFloat(s.pending_expenses) || 0,
      };
    });

    res.json({
      transactions,
      total: parseInt(countQ.rows[0]?.total) || 0,
      limit,
      offset,
      summary: {
        income: parseFloat(sumTotalQ.rows[0]?.income) || 0,
        expenses: parseFloat(sumTotalQ.rows[0]?.expenses) || 0,
        pending_income: parseFloat(sumTotalQ.rows[0]?.pending_income) || 0,
        pending_expenses: parseFloat(sumTotalQ.rows[0]?.pending_expenses) || 0,
      },
      breakdown,
      company_count: companies.length,
      filtered_company_id: filterCompanyId,
    });
  } catch (err) {
    console.error('[meAggregates] /transactions error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao listar lancamentos consolidados' });
  }
});

// ──────────────────────────────────────────────────────────
// GET /me/customers — Onda 2.3
// ──────────────────────────────────────────────────────────
router.get('/customers', async (req, res) => {
  try {
    const userId = req.user.id;
    const companies = await getUserCompanies(userId);

    const planLimit = getPlanLimit(req.user?.plan);
    const limit = Math.min(parseInt(req.query.limit) || planLimit, planLimit);
    const offset = parseInt(req.query.offset) || 0;
    const search = req.query.search;

    if (companies.length === 0) {
      return res.json({
        customers: [], total: 0, limit, offset,
        plan_limit: planLimit, company_count: 0,
      });
    }

    const companyIds = companies.map(c => c.id);
    const companyNameById = new Map(
      companies.map(c => [c.id, c.trade_name || c.legal_name || 'Empresa'])
    );

    let where = 'WHERE company_id = ANY($1)';
    const params = [companyIds];
    if (search) {
      where += ` AND (name ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1} OR phone ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM customers ${where}`,
      params
    );

    const dataRes = await db.query(
      `SELECT id, name, cpf_cnpj, email, phone, birth_date, instagram_handle,
              total_purchases, total_spent, last_purchase_at, first_purchase_at,
              notes, is_active, created_at, company_id
         FROM customers ${where}
        ORDER BY name ASC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const customers = dataRes.rows.map(r => ({
      id: r.id, name: r.name || '', email: r.email || '', phone: r.phone || '',
      cpf_cnpj: r.cpf_cnpj || '',
      birthday: r.birth_date ? new Date(r.birth_date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '',
      birth_date: r.birth_date,
      instagram: r.instagram_handle || '',
      instagram_handle: r.instagram_handle || '',
      total_spent: parseFloat(r.total_spent) || 0,
      totalSpent: parseFloat(r.total_spent) || 0,
      visits: parseInt(r.total_purchases) || 0,
      visit_count: parseInt(r.total_purchases) || 0,
      last_purchase: r.last_purchase_at,
      first_visit: r.first_purchase_at,
      notes: r.notes || '',
      is_active: r.is_active !== false,
      rating: null,
      created_at: r.created_at,
      company_id: r.company_id,
      company_name: companyNameById.get(r.company_id) || 'Empresa',
    }));

    res.json({
      customers,
      total: parseInt(countRes.rows[0]?.total) || 0,
      limit, offset,
      plan_limit: planLimit,
      company_count: companies.length,
    });
  } catch (err) {
    console.error('[meAggregates] /customers error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao listar clientes consolidados' });
  }
});

// ──────────────────────────────────────────────────────────
// GET /me/sales — Onda 2.4
// ──────────────────────────────────────────────────────────
router.get('/sales', async (req, res) => {
  try {
    const userId = req.user.id;
    const companies = await getUserCompanies(userId);

    const limitNum = Math.min(parseInt(req.query.limit) || 50, 200);
    const offsetNum = parseInt(req.query.offset) || 0;

    if (companies.length === 0) {
      return res.json({
        sales: [], total: 0, limit: limitNum, offset: offsetNum,
        stats: { total_sales: 0, active_sales: 0, cancelled_sales: 0, revenue: 0, avg_ticket: 0 },
        breakdown: [], company_count: 0, filtered_company_id: null,
      });
    }

    let companyIds = companies.map(c => c.id);
    const filterCompanyId = req.query.company_id || null;

    if (filterCompanyId) {
      if (!companyIds.includes(filterCompanyId)) {
        return res.status(403).json({ error: 'Sem acesso a essa empresa' });
      }
      companyIds = [filterCompanyId];
    }

    const { date_from, date_to, status, seller_id, customer_id, q } = req.query;

    const conds = ['s.company_id = ANY($1)'];
    const vals = [companyIds];
    let i = 2;

    if (date_from) {
      conds.push(`s.created_at >= $${i++}::timestamptz`);
      vals.push(date_from);
    }
    if (date_to) {
      conds.push(`s.created_at <= $${i++}::timestamptz`);
      vals.push(date_to);
    }
    if (status === 'active') {
      conds.push("COALESCE(s.status, 'completed') != 'cancelled'");
    } else if (status === 'cancelled') {
      conds.push("s.status = 'cancelled'");
    }
    if (seller_id) {
      conds.push(`(s.seller_id = $${i} OR s.employee_id = $${i})`);
      vals.push(seller_id);
      i++;
    }
    if (customer_id) {
      conds.push(`s.customer_id = $${i++}`);
      vals.push(customer_id);
    }
    if (q && String(q).trim()) {
      conds.push(`(c.name ILIKE $${i} OR COALESCE(s.seller_name, e.name) ILIKE $${i})`);
      vals.push('%' + String(q).trim() + '%');
      i++;
    }

    const whereClause = conds.join(' AND ');

    const countRes = await db.query(
      `SELECT COUNT(*)::int AS total
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id
        WHERE ${whereClause}`,
      vals
    );
    const total = countRes.rows[0]?.total || 0;

    const listRes = await db.query(
      `SELECT s.id, s.total_amount, s.discount_amount, s.payment_method, s.status,
              COALESCE(s.type, 'sale') AS type,
              s.cancelled_at, s.created_at,
              s.customer_id, c.name AS customer_name,
              s.seller_id, COALESCE(s.seller_name, e.name) AS seller_name, s.employee_id,
              (SELECT COUNT(*)::int FROM sale_items WHERE sale_id = s.id) AS items_count,
              (SELECT t.id FROM transactions t WHERE t.idempotency_key = 'pdv-sale-' || s.id AND t.company_id = s.company_id LIMIT 1) AS transaction_id,
              s.company_id
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id
        WHERE ${whereClause}
        ORDER BY s.created_at DESC
        LIMIT $${vals.length + 1} OFFSET $${vals.length + 2}`,
      [...vals, limitNum, offsetNum]
    );

    const statsRes = await db.query(
      `SELECT
         COUNT(*)::int AS total_sales,
         COUNT(*) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled')::int AS active_sales,
         COUNT(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled_sales,
         COALESCE(SUM(s.total_amount) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled'), 0)::numeric AS revenue,
         COALESCE(AVG(s.total_amount) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled'), 0)::numeric AS avg_ticket
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id
        WHERE ${whereClause}`,
      vals
    );
    const stats = statsRes.rows[0] || {};

    const breakdownRes = await db.query(
      `SELECT s.company_id,
              COUNT(*)::int AS total_sales,
              COUNT(*) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled')::int AS active_sales,
              COUNT(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled_sales,
              COALESCE(SUM(s.total_amount) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled'), 0)::numeric AS revenue,
              COALESCE(AVG(s.total_amount) FILTER (WHERE COALESCE(s.status, 'completed') != 'cancelled'), 0)::numeric AS avg_ticket
         FROM sales s
         LEFT JOIN customers c ON c.id = s.customer_id
         LEFT JOIN employees e ON e.id = s.employee_id OR e.id = s.seller_id
        WHERE ${whereClause}
        GROUP BY s.company_id`,
      vals
    );

    const companyMap = new Map(companies.map(c => [c.id, c]));
    const breakdownMap = new Map(breakdownRes.rows.map(r => [r.company_id, r]));

    const breakdownCompanies = filterCompanyId
      ? companies.filter(c => c.id === filterCompanyId)
      : companies;

    const breakdown = breakdownCompanies.map(c => {
      const b = breakdownMap.get(c.id) || {};
      return {
        company_id: c.id,
        company_name: c.trade_name || c.legal_name || 'Empresa',
        is_primary: c.is_primary,
        total_sales: parseInt(b.total_sales) || 0,
        active_sales: parseInt(b.active_sales) || 0,
        cancelled_sales: parseInt(b.cancelled_sales) || 0,
        revenue: parseFloat(b.revenue) || 0,
        avg_ticket: parseFloat(b.avg_ticket) || 0,
      };
    });

    const sales = listRes.rows.map(r => {
      const c = companyMap.get(r.company_id);
      return {
        id: r.id,
        total_amount: parseFloat(r.total_amount),
        discount_amount: parseFloat(r.discount_amount || 0),
        payment_method: r.payment_method,
        status: r.status || 'completed',
        type: r.type || 'sale',
        cancelled_at: r.cancelled_at,
        created_at: r.created_at,
        customer: r.customer_id ? { id: r.customer_id, name: r.customer_name } : null,
        seller: { id: r.seller_id || r.employee_id || null, name: r.seller_name || null },
        items_count: r.items_count,
        transaction_id: r.transaction_id,
        company_id: r.company_id,
        company_name: c ? (c.trade_name || c.legal_name || 'Empresa') : 'Empresa',
      };
    });

    res.json({
      sales,
      total,
      limit: limitNum,
      offset: offsetNum,
      stats: {
        total_sales: parseInt(stats.total_sales) || 0,
        active_sales: parseInt(stats.active_sales) || 0,
        cancelled_sales: parseInt(stats.cancelled_sales) || 0,
        revenue: parseFloat(stats.revenue) || 0,
        avg_ticket: parseFloat(stats.avg_ticket) || 0,
      },
      breakdown,
      company_count: companies.length,
      filtered_company_id: filterCompanyId,
    });
  } catch (err) {
    console.error('[meAggregates] /sales error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao listar vendas consolidadas' });
  }
});

// ──────────────────────────────────────────────────────────
// GET /me/sales/analytics — Onda 2.6 (polish final)
//
// 09/05/2026 (fonte unica vendas): total_revenue agora deriva de
// SALES.total_amount (mesma fonte que /me/dashboard salesToday e que
// /me/sales stats.revenue). Antes vinha de transactions confirmed,
// causando divergencia visivel entre KPI top do Painel e o card
// Analytics no MESMO Painel (Eryca Finesse 09/05: 7651 vs 7247).
//
// 11/05/2026: exclui type='troca' em summary/series/by_payment.
// Trocas tem total_amount = newValue inflando analytics. Mesmo fix
// do /me/dashboard. top_products/top_employees mantidos sem filtro
// (itens reais vendidos e seller real ainda contam).
//
// Query params:
//   - period: 'today' | 'yesterday' | 'week' | 'month' | 'year' | 'custom'
//   - group_by: 'day' | 'week' | 'month'
//   - start_date, end_date (so usado se period='custom')
//   - company_id: drill-down opcional dentro do consolidado
// ──────────────────────────────────────────────────────────
router.get('/sales/analytics', async (req, res) => {
  try {
    const userId = req.user.id;
    const companies = await getUserCompanies(userId);

    if (companies.length === 0) {
      return res.json({
        period: { start: null, end: null, label: req.query.period || 'month' },
        summary: {
          total_sales: 0, total_revenue: 0, avg_ticket: 0,
          total_discounts: 0, unique_customers: 0, active_days: 0,
        },
        series: [],
        top_products: [],
        top_employees: [],
        by_payment: [],
        company_count: 0,
        filtered_company_id: null,
      });
    }

    let companyIds = companies.map(c => c.id);
    const filterCompanyId = req.query.company_id || null;

    if (filterCompanyId) {
      if (!companyIds.includes(filterCompanyId)) {
        return res.status(403).json({ error: 'Sem acesso a essa empresa' });
      }
      companyIds = [filterCompanyId];
    }

    const period = req.query.period || 'month';
    const groupBy = req.query.group_by || 'day';
    const { startDate, endDate } = resolvePeriod(period, req.query.start_date, req.query.end_date);

    const SP = `AT TIME ZONE 'America/Sao_Paulo'`;
    const spCol = `(created_at ${SP})`;

    const formats = {
      day:   `${spCol}::date`,
      week:  `DATE_TRUNC('week',  ${spCol})`,
      month: `DATE_TRUNC('month', ${spCol})`,
    };
    const fmt = formats[groupBy] || formats.day;

    // 11/05/2026: filtro de troca centralizado. Aplicado em summary,
    // series e by_payment (todas agregadoras de receita). NAO aplicado
    // em top_products/top_employees (preserva atribuicao de itens reais
    // e credito de vendedora mesmo em trocas).
    const NO_TROCA = `AND COALESCE(type, 'sale') = 'sale'`;
    const NO_TROCA_S = `AND COALESCE(s.type, 'sale') = 'sale'`;

    const [
      summaryRes,
      seriesRes,
      topProductsRes,
      topEmployeesRes,
      byPaymentRes,
    ] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE COALESCE(status,'completed') != 'cancelled')::int                AS total_sales,
           COALESCE(SUM(total_amount) FILTER (WHERE COALESCE(status,'completed') != 'cancelled'), 0) AS total_revenue,
           COALESCE(SUM(discount_amount) FILTER (WHERE COALESCE(status,'completed') != 'cancelled'), 0) AS total_discounts,
           COUNT(DISTINCT customer_id) FILTER (WHERE COALESCE(status,'completed') != 'cancelled')::int  AS unique_customers,
           COUNT(DISTINCT (created_at ${SP})::date) FILTER (WHERE COALESCE(status,'completed') != 'cancelled')::int AS active_days
         FROM sales
         WHERE company_id = ANY($1)
           ${NO_TROCA}
           AND (created_at ${SP}) >= $2::timestamp
           AND (created_at ${SP}) <  $3::timestamp`,
        [companyIds, startDate, endDate]
      ),

      db.query(
        `SELECT ${fmt} AS period,
                COUNT(*)::int                  AS total_sales,
                COALESCE(SUM(total_amount), 0) AS total_revenue
         FROM sales
         WHERE company_id = ANY($1)
           AND COALESCE(status, 'completed') != 'cancelled'
           ${NO_TROCA}
           AND ${spCol} >= $2::timestamp
           AND ${spCol} <  $3::timestamp
         GROUP BY 1
         ORDER BY 1`,
        [companyIds, startDate, endDate]
      ),

      db.query(
        `SELECT
           p.id, p.name, p.category,
           SUM(si.quantity)::float          AS total_qty,
           COALESCE(SUM(si.total_price), 0) AS total_revenue,
           COUNT(DISTINCT s.id)::int        AS appearances
         FROM sale_items si
         JOIN sales    s ON s.id  = si.sale_id
         JOIN products p ON p.id  = si.product_id
         WHERE s.company_id = ANY($1)
           AND COALESCE(s.status, 'completed') != 'cancelled'
           AND (s.created_at ${SP}) >= $2::timestamp
           AND (s.created_at ${SP}) <  $3::timestamp
         GROUP BY p.id, p.name, p.category
         ORDER BY total_revenue DESC
         LIMIT 10`,
        [companyIds, startDate, endDate]
      ),

      db.query(
        `SELECT
           u.id, u.full_name,
           COUNT(s.id)::int                 AS total_sales,
           COALESCE(SUM(s.total_amount), 0) AS total_revenue,
           COALESCE(AVG(s.total_amount), 0) AS avg_ticket
         FROM sales s
         JOIN users u ON u.id = s.seller_id
         WHERE s.company_id = ANY($1)
           AND COALESCE(s.status, 'completed') != 'cancelled'
           AND (s.created_at ${SP}) >= $2::timestamp
           AND (s.created_at ${SP}) <  $3::timestamp
           AND s.seller_id IS NOT NULL
         GROUP BY u.id, u.full_name
         ORDER BY total_revenue DESC
         LIMIT 10`,
        [companyIds, startDate, endDate]
      ),

      db.query(
        `SELECT
           COALESCE(payment_method, 'nao informado') AS method,
           COUNT(*)::int                              AS total_sales,
           COALESCE(SUM(total_amount), 0)             AS total_revenue
         FROM sales
         WHERE company_id = ANY($1)
           AND COALESCE(status, 'completed') != 'cancelled'
           ${NO_TROCA}
           AND (created_at ${SP}) >= $2::timestamp
           AND (created_at ${SP}) <  $3::timestamp
         GROUP BY payment_method
         ORDER BY total_revenue DESC`,
        [companyIds, startDate, endDate]
      ),
    ]);

    const sumRow = summaryRes.rows[0] || {};

    const totalRevenue = parseFloat(sumRow.total_revenue) || 0;
    const totalSales   = parseInt(sumRow.total_sales)     || 0;
    const avgTicket    = totalSales > 0
      ? parseFloat((totalRevenue / totalSales).toFixed(2))
      : 0;

    res.json({
      period: { start: startDate, end: endDate, label: period },
      summary: {
        total_sales:      totalSales,
        total_revenue:    totalRevenue,
        avg_ticket:       avgTicket,
        total_discounts:  parseFloat(sumRow.total_discounts)  || 0,
        unique_customers: parseInt(sumRow.unique_customers)   || 0,
        active_days:      parseInt(sumRow.active_days)        || 0,
      },
      series: seriesRes.rows.map(r => ({
        period: r.period,
        total_sales: r.total_sales,
        total_revenue: parseFloat(r.total_revenue) || 0,
      })),
      top_products: topProductsRes.rows.map(r => ({
        id:            r.id,
        name:          r.name,
        category:      r.category,
        total_qty:     parseFloat(r.total_qty),
        total_revenue: parseFloat(r.total_revenue),
        appearances:   r.appearances,
      })),
      top_employees: topEmployeesRes.rows.map(r => ({
        id:            r.id,
        full_name:     r.full_name,
        total_sales:   r.total_sales,
        total_revenue: parseFloat(r.total_revenue),
        avg_ticket:    parseFloat(parseFloat(r.avg_ticket).toFixed(2)),
      })),
      by_payment: byPaymentRes.rows.map(r => ({
        method:        r.method,
        total_sales:   r.total_sales,
        total_revenue: parseFloat(r.total_revenue),
      })),
      company_count: companies.length,
      filtered_company_id: filterCompanyId,
    });
  } catch (err) {
    console.error('[meAggregates] /sales/analytics error:', err.message, err.stack);
    res.status(500).json({ error: 'Erro ao calcular analytics de vendas consolidadas' });
  }
});

module.exports = router;
