// ============================================================
// AURA. — Financeiro v2: Insights agregados (Health Score / Runway / Biggest Lever)
//
// Endpoints:
//   GET /companies/:id/financeiro/insights?period=month  (per-company)
//   GET /me/financeiro/insights?period=month             (consolidated multi-CNPJ)
//
// Retorna o JSON consumido por:
//   aura-app: hooks/useFinancialInsights.ts (mescla server > client)
//   components/screens/financeiro/v2/HealthScoreHero.tsx
//   components/screens/financeiro/v2/RunwayCard.tsx
//   components/screens/financeiro/v2/BiggestLever.tsx
//
// Onda 1 (este commit): calculos basicos sobre tabela transactions.
// Ondas seguintes: enriquecer chamando services existentes (smartAlerts,
// cashFlowProjection, employeesRanking, dre) e mesclar.
//
// Multi-CNPJ: meRouter agrega todas as company_ids acessiveis pelo usuario
// (lendo company_users) e soma transactions com WHERE company_id IN (...).
// ============================================================

const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

// ── Constantes do Health Score (espelham aura-app/components/screens/financeiro/v2/types.ts).
// Mantenha sincronizado se ajustar pesos/metas em algum dos lados.
const HEALTH_TARGETS = {
  margin_pct: 20,        // margem liquida >= 20%
  runway_days: 60,       // runway >= 60 dias
  growth_mom_pct: 0,     // crescimento MoM positivo (clamp inferior em -10%)
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

// Period -> { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', days: number }
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

// Core: calcula insights pra um conjunto de company_ids (1 = per-company, N = consolidated)
async function computeInsights(companyIds, period) {
  const range = computeRange(period);
  const prev = previousRange(period);

  // Summary do periodo
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
  const sumRes = await db.query(summarySQL, [companyIds, range.start, range.end]);
  const sum = sumRes.rows[0];
  const income = parseFloat(sum.income) || 0;
  const expenses = parseFloat(sum.expenses) || 0;
  const incomeCount = parseInt(sum.income_count) || 0;
  const txCount = parseInt(sum.tx_count) || 0;
  const balance = income - expenses;

  // Periodo anterior (pra crescimento)
  let prevIncome = 0;
  if (prev) {
    const prevRes = await db.query(summarySQL, [companyIds, prev.start, prev.end]);
    prevIncome = parseFloat(prevRes.rows[0].income) || 0;
  }

  // Atrasados (a receber pendentes com due_date < hoje)
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
  const overdueRes = await db.query(overdueSQL, [companyIds]);
  const overdue = overdueRes.rows[0];
  const overdueTotal = parseFloat(overdue.total) || 0;
  const overdueCount = parseInt(overdue.count) || 0;
  const oldestDays = parseInt(overdue.oldest_days) || 0;

  // ---- Drivers ----
  const margem = income > 0 ? ((balance / income) * 100) : 0;
  const margemScore = scoreVsTarget(margem, HEALTH_TARGETS.margin_pct);

  const dailyBurn = range.days > 0 && expenses > 0 ? (expenses / range.days) : 0;
  const cashBalance = balance > 0 ? balance : 0;
  const runwayDays = dailyBurn > 0 ? Math.round(cashBalance / dailyBurn) : 999;
  const runwayScore = scoreVsTarget(Math.min(runwayDays, 180), HEALTH_TARGETS.runway_days);

  const growth = prevIncome > 0 ? (((income - prevIncome) / prevIncome) * 100) : 0;
  const growthScore = scoreVsTarget(Math.max(growth, -10) + 10, 10);

  const ticketScore = 80; // baseline em construcao (Onda 2 vai usar media 6m)

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

  // ---- Biggest Lever ----
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
    // Onda 2 vai preencher: cashflow, income_breakdown, expense_breakdown,
    // anomalies (smartAlerts), professionals (employeesRanking), reconciliation.
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
// Lista company_ids acessiveis pelo usuario via company_users e agrega.
const meRouter = express.Router();
meRouter.use(requireAuth);

meRouter.get('/insights', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Nao autenticado' });

    const period = req.query.period || 'month';

    // Pega todas as empresas que o usuario tem acesso
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
