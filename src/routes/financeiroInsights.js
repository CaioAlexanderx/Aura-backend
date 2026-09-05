// ============================================================
// AURA. — Financeiro v2: Insights agregados (Onda 3 — cashflow + evolução + ranking)
//
// Endpoints:
//   GET /companies/:id/financeiro/insights?period=month  (per-company)
//   GET /me/financeiro/insights?period=month             (consolidated multi-CNPJ)
//
// Onda 1: Health Score + Runway + Biggest Lever
// Onda 2: Top5 + payment methods + timeline + DOW + anomalias
// Onda 3 (este commit):
//   - cashflow.history (últimos 30 dias dia a dia)
//   - cashflow.projection [30, 60, 90] com banda confiança ±15%
//   - monthly_evolution (últimos 12 meses income/expense/balance)
//   - professional_ranking (só per-company, JOIN employees)
//
// Pulado pra Onda 4: fixed_vs_variable_6m (precisa schema migration na
// transactions pra rotular fixed/variable, ou heurística por categoria).
//
// Multi-CNPJ: ranking só per-company (employees nao tem cross-company JOIN).
// Cashflow history e monthly_evolution funcionam consolidated normalmente.
// ============================================================

const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const HEALTH_TARGETS = {
  margin_pct: 20,
  runway_days: 60,
  growth_mom_pct: 0,
};
const HEALTH_WEIGHTS = {
  margem: 0.35,
  runway: 0.35,
  crescimento: 0.20,
  ticket: 0.10,
};

function scoreVsTarget(actual, target, clampMin) {
  if (clampMin == null) clampMin = 0;
  if (target <= 0) return 100;
  const v = Math.max(clampMin, actual);
  if (v >= target) return 100;
  if (v <= 0) return 0;
  return Math.round((v / target) * 100);
}

function computeRange(period) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const isoOf = (d) => d.toISOString().slice(0, 10);

  switch (period) {
    case 'today':
      return { start: todayStr, end: todayStr, days: 1 };
    case 'week': {
      const s = new Date(today);
      s.setDate(today.getDate() - 6);
      return { start: isoOf(s), end: todayStr, days: 7 };
    }
    case 'year': {
      const s = new Date(today.getFullYear(), 0, 1);
      return { start: isoOf(s), end: todayStr, days: 365 };
    }
    case 'all':
      return { start: '1970-01-01', end: todayStr, days: 90 };
    case 'month':
    default: {
      const s = new Date(today.getFullYear(), today.getMonth(), 1);
      return { start: isoOf(s), end: todayStr, days: 30 };
    }
  }
}

function previousRange(period) {
  const today = new Date();
  const isoOf = (d) => d.toISOString().slice(0, 10);
  switch (period) {
    case 'today': {
      const y = new Date(today); y.setDate(today.getDate() - 1);
      return { start: isoOf(y), end: isoOf(y) };
    }
    case 'week': {
      const e = new Date(today); e.setDate(today.getDate() - 7);
      const s = new Date(e); s.setDate(e.getDate() - 6);
      return { start: isoOf(s), end: isoOf(e) };
    }
    case 'year': {
      const y = today.getFullYear() - 1;
      return { start: y + '-01-01', end: y + '-12-31' };
    }
    case 'all':
      return null;
    case 'month':
    default: {
      const pm = today.getMonth() - 1;
      const yr = pm < 0 ? today.getFullYear() - 1 : today.getFullYear();
      const m = pm < 0 ? 11 : pm;
      const lastDay = new Date(yr, m + 1, 0).getDate();
      const mm = String(m + 1).padStart(2, '0');
      return {
        start: yr + '-' + mm + '-01',
        end: yr + '-' + mm + '-' + String(lastDay).padStart(2, '0'),
      };
    }
  }
}

function fmtBRL(v) {
  return 'R$ ' + Math.round(v).toLocaleString('pt-BR');
}

// ============================================================
// Helpers Onda 2 (preservados)
// ============================================================
async function fetchTop5(companyIds, type, start, end) {
  // companies não tem coluna `name` — usa trade_name (fantasia) com fallback
  // pra legal_name (razão social). Bug anterior: c.name → 42703 quebrava tela.
  const sql = `
    SELECT id, description, category, amount, payment_method, employee_name,
           status, COALESCE(due_date, created_at::date) AS event_date,
           company_id, company_name
    FROM (
      SELECT t.*, COALESCE(c.trade_name, c.legal_name) AS company_name
      FROM transactions t
      LEFT JOIN companies c ON c.id = t.company_id
      WHERE t.company_id = ANY($1::uuid[])
        AND t.type = $2
        AND t.status = 'confirmed'
        AND COALESCE(t.due_date, t.created_at::date) BETWEEN $3::date AND $4::date
    ) sub
    ORDER BY amount DESC
    LIMIT 5
  `;
  const r = await db.query(sql, [companyIds, type, start, end]);
  return r.rows.map((row) => ({
    id: row.id,
    description: row.description || 'Lancamento',
    category: row.category || 'Outros',
    amount: parseFloat(row.amount) || 0,
    payment_method: row.payment_method || null,
    employee_name: row.employee_name || null,
    status: row.status,
    date: row.event_date,
    company_name: row.company_name || null,
  }));
}

async function fetchPaymentMethods(companyIds, type, start, end) {
  const sql = `
    SELECT
      COALESCE(NULLIF(payment_method, ''), 'Outros') AS method,
      SUM(amount) AS total,
      COUNT(*) AS count
    FROM transactions
    WHERE company_id = ANY($1::uuid[])
      AND type = $2
      AND status = 'confirmed'
      AND COALESCE(due_date, created_at::date) BETWEEN $3::date AND $4::date
    GROUP BY method
    ORDER BY total DESC
    LIMIT 8
  `;
  const r = await db.query(sql, [companyIds, type, start, end]);
  const total = r.rows.reduce((s, row) => s + (parseFloat(row.total) || 0), 0);
  return r.rows.map((row) => {
    const v = parseFloat(row.total) || 0;
    return {
      label: row.method,
      value: v,
      count: parseInt(row.count) || 0,
      pct: total > 0 ? (v / total) * 100 : 0,
    };
  });
}

async function fetchTimeline(companyIds, type) {
  const sql = `
    SELECT
      CASE
        WHEN due_date::date < CURRENT_DATE THEN 'atrasadas'
        WHEN due_date::date <= CURRENT_DATE + INTERVAL '7 days' THEN 'esta_semana'
        WHEN due_date::date <= (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::date THEN 'este_mes'
        ELSE 'futuras'
      END AS bucket,
      SUM(amount) AS total,
      COUNT(*) AS count
    FROM transactions
    WHERE company_id = ANY($1::uuid[])
      AND type = $2
      AND status = 'pending'
      AND due_date IS NOT NULL
    GROUP BY bucket
  `;
  const r = await db.query(sql, [companyIds, type]);
  const out = { atrasadas: { total: 0, count: 0 }, esta_semana: { total: 0, count: 0 }, este_mes: { total: 0, count: 0 }, futuras: { total: 0, count: 0 } };
  r.rows.forEach((row) => {
    out[row.bucket] = { total: parseFloat(row.total) || 0, count: parseInt(row.count) || 0 };
  });
  return out;
}

async function fetchDowBreakdown(companyIds, type, start, end) {
  const sql = `
    SELECT
      EXTRACT(DOW FROM COALESCE(due_date, created_at::date))::int AS dow,
      SUM(amount) AS total,
      COUNT(*) AS count
    FROM transactions
    WHERE company_id = ANY($1::uuid[])
      AND type = $2
      AND status = 'confirmed'
      AND COALESCE(due_date, created_at::date) BETWEEN $3::date AND $4::date
    GROUP BY dow
    ORDER BY dow
  `;
  const r = await db.query(sql, [companyIds, type, start, end]);
  const labels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
  const map = {};
  r.rows.forEach((row) => {
    map[parseInt(row.dow)] = { total: parseFloat(row.total) || 0, count: parseInt(row.count) || 0 };
  });
  return labels.map((label, i) => ({
    dow: i,
    label: label,
    total: map[i] ? map[i].total : 0,
    count: map[i] ? map[i].count : 0,
  }));
}

async function fetchAnomalies(companyIds, start, end) {
  const sql = `
    WITH current_period AS (
      SELECT category, SUM(amount) AS cur_total
      FROM transactions
      WHERE company_id = ANY($1::uuid[])
        AND type = 'expense'
        AND status = 'confirmed'
        AND COALESCE(due_date, created_at::date) BETWEEN $2::date AND $3::date
      GROUP BY category
    ),
    prior_months AS (
      SELECT
        category,
        date_trunc('month', COALESCE(due_date, created_at::date)) AS m,
        SUM(amount) AS month_total
      FROM transactions
      WHERE company_id = ANY($1::uuid[])
        AND type = 'expense'
        AND status = 'confirmed'
        AND COALESCE(due_date, created_at::date) >= ($2::date - INTERVAL '3 months')
        AND COALESCE(due_date, created_at::date) < $2::date
      GROUP BY category, m
    ),
    prior_avg AS (
      SELECT category, AVG(month_total) AS avg_total
      FROM prior_months
      GROUP BY category
      HAVING AVG(month_total) > 0
    )
    SELECT
      cp.category,
      cp.cur_total,
      COALESCE(pa.avg_total, 0) AS avg_total,
      CASE WHEN pa.avg_total > 0
           THEN ((cp.cur_total - pa.avg_total) / pa.avg_total) * 100
           ELSE 0 END AS diff_pct
    FROM current_period cp
    LEFT JOIN prior_avg pa ON pa.category = cp.category
    WHERE pa.avg_total > 0
      AND ((cp.cur_total - pa.avg_total) / pa.avg_total) > 0.20
    ORDER BY diff_pct DESC
    LIMIT 5
  `;
  try {
    const r = await db.query(sql, [companyIds, start, end]);
    return r.rows.map((row) => ({
      category: row.category || 'Outros',
      current: parseFloat(row.cur_total) || 0,
      avg_3m: parseFloat(row.avg_total) || 0,
      diff_pct: parseFloat(row.diff_pct) || 0,
    }));
  } catch (err) {
    console.warn('[financeiroInsights] anomalies failed:', err.message);
    return [];
  }
}

// ============================================================
// Helpers Onda 3 — novas queries
// ============================================================

// Cashflow histórico — últimos 30 dias dia a dia.
// Usa generate_series pra preencher dias sem transacao com 0.
async function fetchCashflowHistory(companyIds) {
  const sql = `
    SELECT
      d.day::date AS date,
      COALESCE(SUM(CASE WHEN t.type='income' AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN t.type='expense' AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS expenses
    FROM generate_series(
      CURRENT_DATE - INTERVAL '29 days',
      CURRENT_DATE,
      '1 day'
    ) AS d(day)
    LEFT JOIN transactions t
      ON t.company_id = ANY($1::uuid[])
      AND COALESCE(t.due_date, t.created_at::date) = d.day::date
    GROUP BY d.day
    ORDER BY d.day
  `;
  const r = await db.query(sql, [companyIds]);
  return r.rows.map((row) => {
    const inc = parseFloat(row.income) || 0;
    const exp = parseFloat(row.expenses) || 0;
    return {
      date: row.date.toISOString ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
      income: inc,
      expenses: exp,
      net: inc - exp,
    };
  });
}

// Projection 30/60/90 — média móvel dos últimos 30 dias + banda confiança ±15%.
// Calcula a partir do history (já fetchado), nao precisa nova query.
function buildCashflowProjection(history) {
  if (!history || history.length === 0) {
    return { avg_daily_net: 0, std_daily_net: 0, projection: [] };
  }

  const nets = history.map((d) => d.net);
  const avg = nets.reduce((s, n) => s + n, 0) / nets.length;
  const variance = nets.reduce((s, n) => s + Math.pow(n - avg, 2), 0) / nets.length;
  const std = Math.sqrt(variance);

  // Banda confiança: usa max(±15% do projection, ±std diário scaled by sqrt(days)).
  // Simplificado: 15% do valor projetado.
  const projection = [30, 60, 90].map((daysAhead) => {
    const value = avg * daysAhead;
    const bandPct = 0.15;
    return {
      days_ahead: daysAhead,
      value: Math.round(value),
      low: Math.round(value * (1 - bandPct)),
      high: Math.round(value * (1 + bandPct)),
    };
  });

  return {
    avg_daily_net: Math.round(avg),
    std_daily_net: Math.round(std),
    projection: projection,
  };
}

// Monthly evolution — últimos 12 meses (incluindo o atual).
async function fetchMonthlyEvolution(companyIds) {
  const sql = `
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', CURRENT_DATE - INTERVAL '11 months'),
        date_trunc('month', CURRENT_DATE),
        '1 month'
      ) AS m
    )
    SELECT
      m.m::date AS month,
      COALESCE(SUM(CASE WHEN t.type='income' AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN t.type='expense' AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS expenses
    FROM months m
    LEFT JOIN transactions t
      ON t.company_id = ANY($1::uuid[])
      AND date_trunc('month', COALESCE(t.due_date, t.created_at::date)) = m.m
    GROUP BY m.m
    ORDER BY m.m
  `;
  const r = await db.query(sql, [companyIds]);
  return r.rows.map((row) => {
    const inc = parseFloat(row.income) || 0;
    const exp = parseFloat(row.expenses) || 0;
    const date = row.month;
    const dateStr = date.toISOString ? date.toISOString().slice(0, 7) : String(date).slice(0, 7);
    // Label tipo "out/26"
    const [yearStr, monthStr] = dateStr.split('-');
    const monthNames = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const label = monthNames[parseInt(monthStr) - 1] + '/' + yearStr.slice(2);
    return {
      month: dateStr,
      label: label,
      income: inc,
      expenses: exp,
      balance: inc - exp,
    };
  });
}

// Professional ranking — só per-company (employees é per-company).
// Em consolidated, retorna [] (frontend mostra hint pra abrir empresa especifica).
async function fetchProfessionalRanking(companyIds, start, end) {
  if (!companyIds || companyIds.length !== 1) {
    return []; // só per-company
  }
  const sql = `
    SELECT
      e.id,
      e.name,
      COUNT(t.id) AS tx_count,
      COALESCE(SUM(t.amount), 0) AS total,
      COALESCE(AVG(t.amount), 0) AS avg_ticket
    FROM transactions t
    INNER JOIN employees e ON e.id = t.employee_id
    WHERE t.company_id = $1
      AND t.type = 'income'
      AND t.status = 'confirmed'
      AND COALESCE(t.due_date, t.created_at::date) BETWEEN $2::date AND $3::date
    GROUP BY e.id, e.name
    ORDER BY total DESC
    LIMIT 10
  `;
  try {
    const r = await db.query(sql, [companyIds[0], start, end]);
    return r.rows.map((row) => ({
      id: row.id,
      name: row.name || 'Sem nome',
      tx_count: parseInt(row.tx_count) || 0,
      total: parseFloat(row.total) || 0,
      avg_ticket: parseFloat(row.avg_ticket) || 0,
    }));
  } catch (err) {
    // Tabela employees pode nao existir ou employee_id pode estar nulo — retorna vazio
    console.warn('[financeiroInsights] professional_ranking failed:', err.message);
    return [];
  }
}

// Core: calcula insights pra um conjunto de company_ids
async function computeInsights(companyIds, period) {
  const range = computeRange(period);
  const prev = previousRange(period);

  const summarySQL = `
    SELECT
      COALESCE(SUM(CASE WHEN type='income' AND status='confirmed' THEN amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN type='expense' AND status='confirmed' THEN amount ELSE 0 END), 0) AS expenses,
      COALESCE(COUNT(*) FILTER (WHERE type='income' AND status='confirmed'), 0) AS income_count,
      COALESCE(COUNT(*), 0) AS tx_count
    FROM transactions
    WHERE company_id = ANY($1::uuid[])
      AND COALESCE(due_date, created_at::date) BETWEEN $2::date AND $3::date
  `;
  const overdueSQL = `
    SELECT
      COALESCE(SUM(amount), 0) AS total,
      COALESCE(COUNT(*), 0) AS count,
      COALESCE(MAX(CURRENT_DATE - due_date::date), 0) AS oldest_days
    FROM transactions
    WHERE company_id = ANY($1::uuid[])
      AND status = 'pending'
      AND type = 'income'
      AND due_date IS NOT NULL
      AND due_date::date < CURRENT_DATE
  `;
  // Lentidao do Studio (QA 04/09/2026): o app roda em us-west e o banco em
  // Sao Paulo, entao cada ida ao banco custa ~190ms mesmo com a consulta em
  // 1ms. Resumo do periodo, resumo do periodo anterior e atrasados eram tres
  // idas em sequencia ANTES da rodada paralela — 4 rodadas no total. As tres
  // nao dependem uma da outra nem das demais, entao entram na mesma rodada:
  // 4 idas viram 1.
  const [
    sumRes,
    prevRes,
    overdueRes,
    top5Income,
    top5Expense,
    incomeMethods,
    expenseMethods,
    receivableTimeline,
    payableTimeline,
    incomeDow,
    anomalies,
    cashflowHistory,
    monthlyEvolution,
    professionalRanking,
  ] = await Promise.all([
    db.query(summarySQL, [companyIds, range.start, range.end]),
    prev ? db.query(summarySQL, [companyIds, prev.start, prev.end]) : Promise.resolve(null),
    db.query(overdueSQL, [companyIds]),
    fetchTop5(companyIds, 'income', range.start, range.end),
    fetchTop5(companyIds, 'expense', range.start, range.end),
    fetchPaymentMethods(companyIds, 'income', range.start, range.end),
    fetchPaymentMethods(companyIds, 'expense', range.start, range.end),
    fetchTimeline(companyIds, 'income'),
    fetchTimeline(companyIds, 'expense'),
    fetchDowBreakdown(companyIds, 'income', range.start, range.end),
    fetchAnomalies(companyIds, range.start, range.end),
    fetchCashflowHistory(companyIds),
    fetchMonthlyEvolution(companyIds),
    fetchProfessionalRanking(companyIds, range.start, range.end),
  ]);

  const sum = sumRes.rows[0];
  const income = parseFloat(sum.income) || 0;
  const expenses = parseFloat(sum.expenses) || 0;
  const incomeCount = parseInt(sum.income_count) || 0;
  const txCount = parseInt(sum.tx_count) || 0;
  const balance = income - expenses;

  const prevIncome = prevRes ? (parseFloat(prevRes.rows[0].income) || 0) : 0;

  const overdue = overdueRes.rows[0];
  const overdueTotal = parseFloat(overdue.total) || 0;
  const overdueCount = parseInt(overdue.count) || 0;
  const oldestDays = parseInt(overdue.oldest_days) || 0;

  // Cashflow: history + projection derivada
  const projectionData = buildCashflowProjection(cashflowHistory);

  const margem = income > 0 ? ((balance / income) * 100) : 0;
  const margemScore = scoreVsTarget(margem, HEALTH_TARGETS.margin_pct);

  const dailyBurn = range.days > 0 && expenses > 0 ? (expenses / range.days) : 0;
  const cashBalance = balance > 0 ? balance : 0;
  const runwayDays = dailyBurn > 0 ? Math.round(cashBalance / dailyBurn) : 999;
  const runwayScore = scoreVsTarget(Math.min(runwayDays, 180), HEALTH_TARGETS.runway_days);

  const growth = prevIncome > 0 ? (((income - prevIncome) / prevIncome) * 100) : 0;
  const growthScore = scoreVsTarget(Math.max(growth, -10) + 10, 10);

  const ticketScore = 80;

  let score = Math.round(
    HEALTH_WEIGHTS.margem * margemScore +
    HEALTH_WEIGHTS.runway * runwayScore +
    HEALTH_WEIGHTS.crescimento * growthScore +
    HEALTH_WEIGHTS.ticket * ticketScore
  );
  score = Math.max(0, Math.min(100, score));

  const label =
    txCount < 10 ? 'Inicial' :
    score >= 75 ? 'Saudavel' :
    score >= 50 ? 'Atencao' :
    'Critico';

  const leverImpactDays = dailyBurn > 0 ? Math.round(overdueTotal / dailyBurn) : 0;
  let biggest_lever = null;
  if (overdueCount > 0 && overdueTotal > 0) {
    biggest_lever = {
      type: 'collect_overdue',
      headline:
        'Cobrar ' + fmtBRL(overdueTotal) + ' em atraso aumentaria seu runway de ' +
        (runwayDays >= 999 ? '—' : runwayDays) + ' para ' +
        (runwayDays >= 999 ? '—' : (runwayDays + leverImpactDays)) + ' dias',
      amount: overdueTotal,
      impact_days: leverImpactDays,
      count: overdueCount,
      oldest_days: oldestDays,
    };
  }

  const expenseRatio = income > 0 ? Math.round((expenses / income) * 100) : 0;

  return {
    period: period,
    range: range,
    health: {
      score: score,
      label: label,
      drivers: [
        {
          id: 'margem',
          label: 'Margem liquida',
          current: margem.toFixed(1).replace('.', ',') + '%',
          target: '>= ' + HEALTH_TARGETS.margin_pct + '%',
          status: margem >= HEALTH_TARGETS.margin_pct ? 'ok' : margem >= HEALTH_TARGETS.margin_pct * 0.7 ? 'warn' : 'bad',
          gap: margem >= HEALTH_TARGETS.margin_pct
            ? '+' + (margem - HEALTH_TARGETS.margin_pct).toFixed(1).replace('.', ',') + ' pontos acima'
            : (HEALTH_TARGETS.margin_pct - margem).toFixed(1).replace('.', ',') + ' pontos abaixo',
          contribution: HEALTH_WEIGHTS.margem,
        },
        {
          id: 'runway',
          label: 'Runway de caixa',
          current: runwayDays >= 999 ? '—' : runwayDays + 'd',
          target: '>= ' + HEALTH_TARGETS.runway_days + ' dias',
          status: runwayDays >= HEALTH_TARGETS.runway_days ? 'ok' : runwayDays >= 30 ? 'warn' : 'bad',
          gap: runwayDays >= 999 ? 'sem despesas no periodo' :
               runwayDays >= HEALTH_TARGETS.runway_days ? '+' + (runwayDays - HEALTH_TARGETS.runway_days) + ' dias acima' :
               (HEALTH_TARGETS.runway_days - runwayDays) + ' dias abaixo',
          contribution: HEALTH_WEIGHTS.runway,
        },
        {
          id: 'crescimento',
          label: 'Crescimento',
          current: prevIncome > 0 ? (growth >= 0 ? '+' : '') + growth.toFixed(1).replace('.', ',') + '%' : '—',
          target: '>= 0% vs ant.',
          status: growth >= 0 ? 'ok' : growth >= -5 ? 'warn' : 'bad',
          gap: prevIncome === 0 ? 'sem comparativo' : (growth >= 0 ? 'receita subindo' : 'receita caindo'),
          contribution: HEALTH_WEIGHTS.crescimento,
        },
        {
          id: 'ticket',
          label: 'Ticket medio',
          current: incomeCount > 0 ? fmtBRL(income / incomeCount) : '—',
          target: 'vs media 6m',
          status: 'ok',
          gap: 'baseline em construcao',
          contribution: HEALTH_WEIGHTS.ticket,
        },
      ],
    },
    runway: {
      days: runwayDays,
      daily_burn: dailyBurn,
      cash_balance: cashBalance,
    },
    biggest_lever: biggest_lever,
    income_breakdown: {
      top5: top5Income,
      payment_methods: incomeMethods,
      timeline: receivableTimeline,
      dow: incomeDow,
      total: income,
      count: incomeCount,
    },
    expense_breakdown: {
      top5: top5Expense,
      payment_methods: expenseMethods,
      timeline: payableTimeline,
      anomalies: anomalies,
      gauge: {
        expense_pct: expenseRatio,
        zone: expenseRatio < 60 ? 'saudavel' : expenseRatio < 80 ? 'atencao' : 'critico',
      },
      total: expenses,
    },
    // ----- Onda 3 -----
    cashflow: {
      history: cashflowHistory,
      avg_daily_net: projectionData.avg_daily_net,
      std_daily_net: projectionData.std_daily_net,
      projection: projectionData.projection,
    },
    monthly_evolution: monthlyEvolution,
    professional_ranking: professionalRanking,
  };
}

// ── Router per-company: GET /companies/:id/financeiro/insights ───────
const companyRouter = express.Router({ mergeParams: true });

companyRouter.get('/insights', async (req, res) => {
  try {
    const cid = req.params.id;
    const period = req.query.period || 'month';
    const out = await computeInsights([cid], period);
    out.consolidated = false;
    res.json(out);
  } catch (err) {
    console.error('[financeiroInsights/company] error:', err);
    res.status(500).json({ error: 'Erro ao calcular insights' });
  }
});

// ── Router consolidated multi-CNPJ: GET /me/financeiro/insights ──────
const meRouter = express.Router();
meRouter.use(requireAuth);

meRouter.get('/insights', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Nao autenticado' });

    const period = req.query.period || 'month';

    const companiesRes = await db.query(
      `SELECT company_id FROM company_users WHERE user_id = $1`,
      [userId]
    );
    const companyIds = companiesRes.rows.map(r => r.company_id);
    if (companyIds.length === 0) {
      return res.json({
        period: period,
        consolidated: true,
        company_count: 0,
        health: { score: 0, label: 'Inicial', drivers: [] },
        runway: { days: 999, daily_burn: 0, cash_balance: 0 },
        biggest_lever: null,
        income_breakdown: { top5: [], payment_methods: [], timeline: {}, dow: [], total: 0, count: 0 },
        expense_breakdown: { top5: [], payment_methods: [], timeline: {}, anomalies: [], gauge: { expense_pct: 0, zone: 'saudavel' }, total: 0 },
        cashflow: { history: [], avg_daily_net: 0, std_daily_net: 0, projection: [] },
        monthly_evolution: [],
        professional_ranking: [],
      });
    }

    const out = await computeInsights(companyIds, period);
    out.consolidated = true;
    out.company_count = companyIds.length;
    res.json(out);
  } catch (err) {
    console.error('[financeiroInsights/me] error:', err);
    res.status(500).json({ error: 'Erro ao calcular insights consolidados' });
  }
});

module.exports = { companyRouter, meRouter };
