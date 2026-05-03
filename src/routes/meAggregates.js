// ============================================================
// AURA. — Multi-CNPJ Sessao 2: endpoints /me/* consolidados
//
// Estes endpoints agregam dados de TODAS as empresas do user.
// Sao chamados pelo frontend quando consolidatedView=true (modo
// "Todas as empresas" no switcher).
//
// Onda 2.1: /me/dashboard — KPIs somados + breakdown.
// Onda 2.2: /me/transactions — listagem + drill-down via ?company_id=.
// Onda 2.3 (atual): /me/customers — lista UNICA owner-scoped.
//   Decisao: clientes sao "do dono", nao da loja. Lista unica entre
//   todos os CNPJs do mesmo owner. Vendedora membro so de Loja A
//   tambem ve clientes registrados em Loja B do mesmo dono.
// Proximas ondas:
//   2.4: /me/sales
//   2.5: /me/appointments
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
// ============================================================
const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const db = require('../config/database');

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
//
// Lista UNICA de clientes do user. Quando consolidatedView=true,
// FE chama este endpoint em vez do per-company. Retorna mesma
// shape do /companies/:id/customers + cada item com company_id e
// company_name (loja onde foi cadastrado).
//
// Decisao de produto: clientes sao do owner. Vendedora membro so
// de Loja A em modo consolidated (caso raro: ela ser membro de
// >=2 lojas) ve clientes de TODAS as lojas onde tem acesso.
//
// Filtros suportados:
//   - search: busca em name, email, phone (ILIKE)
//   - limit, offset
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
      // Multi-CNPJ: empresa onde foi cadastrado
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

module.exports = router;
