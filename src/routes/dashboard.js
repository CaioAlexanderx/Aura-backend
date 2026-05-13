// ============================================================
// AURA. — PERF-01: Aggregated Dashboard Endpoint
// GET /companies/:id/dashboard
//
// TIMEZONE FIX: todas as agregacoes por data usam SP (America/Sao_Paulo).
// DB roda em UTC — CURRENT_DATE retornaria dia errado apos 21h BRT.
//
// REGIME (revisao 27/04 noite — fechamento Finesse):
//   Filtro de periodo de TRANSACTIONS usa COALESCE(due_date, created_at SP).
//   Manda a "data do lancamento" que o usuario preencheu (default=hoje).
//   Alinha com transactions.js — qualquer mudanca em um exige a outra.
//
//   SALES filtra por created_at SP (sales nao tem due_date — sao
//   eventos instantaneos do PDV). Mantido como esta.
//
//   Recent income (timeline) e customer count tambem por created_at
//   (representam ATIVIDADE recente do app, nao competencia financeira).
//
// FONTE DE RECEITA:
//   revenue = cashInflow = SUM(transactions WHERE type=income AND status=confirmed)
//   no periodo, filtrado por COALESCE(due_date, created_at SP).
//
//   A tabela 'sales' contem entradas invalidas/de-teste que inflam o
//   total. Continua usada apenas para contagem (salesCountMonth, salesToday,
//   avgTicket) e para o card de Vendas (que mantem semantica operacional).
//
// 11/05/2026 — Fix bug Eryca Finesse (salesToday inflado por trocas):
//   today_total e month_count agora excluem s.type='troca'.
//   Trocas tem total_amount = newValue (valor do produto novo), nao o
//   netAmount efetivamente recebido. Somar isso inflava o KPI "Vendas
//   hoje" do Painel. Mesmo fix ja aplicado em /pdv/summary (07/05 PR #41).
//
// 13/05/2026 — Fix formato de data americano (bug Maria/Encanto Presentes):
//   toLocaleDateString('pt-BR') e toLocaleTimeString('pt-BR') silenciosamente
//   caem para en-US no Railway quando Node.js nao tem full-icu instalado.
//   Substituido por fmtDateBR() e fmtTimeSP() que usam aritmetica UTC pura,
//   sem dependencia de dados ICU de locale.
// ============================================================
const router = require('express').Router({ mergeParams: true });
const db     = require('../config/database');

// Safe date/time formatters — evita toLocaleDateString/toLocaleTimeString com
// locale pt-BR, que silenciosamente cai para en-US no Railway sem full-icu.
// America/Sao_Paulo = UTC-3 o ano todo (DST abolido em 2019).
function fmtDateBR(val) {
  if (!val) return '';
  var d = new Date(val);
  var day   = String(d.getUTCDate()).padStart(2, '0');
  var month = String(d.getUTCMonth() + 1).padStart(2, '0');
  var year  = d.getUTCFullYear();
  return day + '/' + month + '/' + year;
}
function fmtTimeSP(val) {
  if (!val) return '--:--';
  var d     = new Date(val);
  var local = new Date(d.getTime() - 3 * 60 * 60 * 1000); // UTC-3
  var hh    = String(local.getUTCHours()).padStart(2, '0');
  var mm    = String(local.getUTCMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

// GET /companies/:id/dashboard
router.get('/', async (req, res) => {
  const cid = req.params.id;
  try {
    const [salesCountRes, prevTxRes, cashFlowRes, recentRes, sparkRes, obligationsRes] = await Promise.all([

      // 1. Contagem de vendas do mes e de hoje — sem somar valor.
      //    Sales filtra por created_at SP (eventos instantaneos do PDV).
      //    O valor financeiro vem de transactions (cashInflow), nao de sales.
      //    11/05/2026: exclui type='troca' (mesmo fix do /pdv/summary 07/05).
      //    Trocas tem total_amount = newValue inflando o KPI "Vendas hoje".
      db.query(
        `SELECT
           COUNT(*)::int AS month_count,
           COALESCE(SUM(CASE WHEN (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date THEN total_amount ELSE 0 END), 0) AS today_total,
           COUNT(*) FILTER (WHERE (created_at AT TIME ZONE 'America/Sao_Paulo')::date = (NOW() AT TIME ZONE 'America/Sao_Paulo')::date)::int AS today_count
         FROM sales
         WHERE company_id = $1
           AND COALESCE(status, 'completed') != 'cancelled'
           AND COALESCE(type, 'sale') = 'sale'
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))
           AND (created_at AT TIME ZONE 'America/Sao_Paulo') < date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month'`,
        [cid]
      ),

      // 2. Income do mes anterior (transactions) — para revenueDelta.
      //    Filtro por COALESCE(due_date, created_at SP).
      db.query(
        `SELECT COALESCE(SUM(amount), 0) AS prev_income
         FROM transactions
         WHERE company_id = $1
           AND type = 'income'
           AND status = 'confirmed'
           AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= (date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) - INTERVAL '1 month')::date
           AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))::date`,
        [cid]
      ),

      // 3. Fluxo de caixa do mes atual (transactions) — fonte principal de receita e despesa.
      //    Filtro por COALESCE(due_date, created_at SP).
      db.query(
        `SELECT
           COALESCE(SUM(CASE WHEN type='income'  AND status='confirmed' THEN amount ELSE 0 END), 0) AS cash_inflow,
           COALESCE(SUM(CASE WHEN type='expense' AND status='confirmed' THEN amount ELSE 0 END), 0) AS cash_expenses,
           COALESCE(SUM(CASE WHEN type='income'  AND status='pending'   THEN amount ELSE 0 END), 0) AS pending_income,
           COALESCE(SUM(CASE WHEN type='expense' AND status='pending'   THEN amount ELSE 0 END), 0) AS pending_expenses
         FROM transactions
         WHERE company_id = $1
           AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo'))::date
           AND COALESCE(due_date, (created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  (date_trunc('month', (NOW() AT TIME ZONE 'America/Sao_Paulo')) + INTERVAL '1 month')::date`,
        [cid]
      ),

      // 4. Ultimas 5 entradas confirmadas — atividade recente (created_at).
      db.query(
        `SELECT id, description, amount, type, created_at
         FROM transactions
         WHERE company_id = $1 AND type = 'income' AND status = 'confirmed'
         ORDER BY created_at DESC LIMIT 5`,
        [cid]
      ),

      // 5. Sparkline ultimos 7 dias — agrupa por data do lancamento
      //    (COALESCE(due_date, created_at SP)) pra ficar consistente com
      //    o saldo/fluxo. Confirmed apenas.
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
           AND COALESCE(t.due_date, (t.created_at AT TIME ZONE 'America/Sao_Paulo')::date) = d.day::date
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

    // Clientes novos no mes (registro de cadastro — created_at)
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
        time:     fmtTimeSP(r.created_at),
        method:   'Pix',
      })),
      obligations: obligationsRes.rows.map(r => ({
        id:       r.id,
        name:     r.name,
        due:      fmtDateBR(r.due_date),
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
