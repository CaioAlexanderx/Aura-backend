// ============================================================
// AURA. — Financeiro: endpoint Comparativo (Fase A redesign 19/05/2026)
//
// Endpoints:
//   GET /companies/:id/financeiro/comparative  (per-company)
//   GET /me/financeiro/comparative              (consolidated multi-CNPJ)
//
// Query params:
//   period       = today | week | month | year | custom    (default: month)
//   compareWith  = previous_period | yoy | custom          (default: previous_period)
//   start, end   = ISO dates (necessario quando period=custom)
//   compareStart, compareEnd = ISO dates (necessario quando compareWith=custom)
//
// Response:
//   {
//     current:  { start, end, label, daily: [{date, income, expenses, net}], totals: {income, expenses, net} },
//     previous: { start, end, label, daily: [...], totals: {...} },
//     delta:    { income_pct, expenses_pct, net_pct },
//     consolidated: bool,
//     company_count: number  // so em /me
//   }
//
// Diferenca do financeiroInsights.cashflow.history:
//   - history e fixo nos ultimos 30 dias; este endpoint usa qualquer range
//   - aqui retorna 2 series alinhadas (current + previous) pra grafico sobreposto
//   - aqui ja inclui totals e delta agregados, sem precisar recalcular no client
// ============================================================

const express = require('express');
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');

const MONTH_NAMES_FULL = [
  'Janeiro', 'Fevereiro', 'Marco', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const MONTH_NAMES_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function isoDate(d) { return d.toISOString().slice(0, 10); }
function parseDate(s) {
  // YYYY-MM-DD → local midnight (evita timezone surprise)
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), 12, 0, 0);
}
function formatRangeLabel(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return '';
  // Mes inteiro no mesmo ano
  if (s.getDate() === 1
      && s.getMonth() === e.getMonth()
      && s.getFullYear() === e.getFullYear()
      && new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate() === e.getDate()) {
    return MONTH_NAMES_FULL[s.getMonth()] + '/' + s.getFullYear();
  }
  // Ano inteiro
  if (s.getDate() === 1 && s.getMonth() === 0 && e.getMonth() === 11 && e.getDate() === 31 && s.getFullYear() === e.getFullYear()) {
    return String(s.getFullYear());
  }
  // Outros: dd/mm a dd/mm
  const fmt = (d) => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
  if (s.getFullYear() === e.getFullYear()) {
    return fmt(s) + ' - ' + fmt(e) + '/' + s.getFullYear();
  }
  return fmt(s) + '/' + s.getFullYear() + ' - ' + fmt(e) + '/' + e.getFullYear();
}

function resolveCurrentRange(period, customStart, customEnd) {
  const today = new Date();
  switch (period) {
    case 'today': {
      const s = isoDate(today);
      return { start: s, end: s };
    }
    case 'week': {
      const s = new Date(today); s.setDate(today.getDate() - 6);
      return { start: isoDate(s), end: isoDate(today) };
    }
    case 'month': {
      const s = new Date(today.getFullYear(), today.getMonth(), 1);
      const e = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      return { start: isoDate(s), end: isoDate(e) };
    }
    case 'year': {
      const s = new Date(today.getFullYear(), 0, 1);
      return { start: isoDate(s), end: isoDate(today) };
    }
    case 'custom': {
      if (!customStart || !customEnd) {
        const err = new Error('period=custom requer start e end');
        err.statusCode = 400;
        throw err;
      }
      return { start: customStart, end: customEnd };
    }
    default: {
      const err = new Error('period invalido: ' + period);
      err.statusCode = 400;
      throw err;
    }
  }
}

function resolveCompareRange(compareWith, currentRange, customCompareStart, customCompareEnd) {
  const cs = parseDate(currentRange.start);
  const ce = parseDate(currentRange.end);
  if (!cs || !ce) {
    const err = new Error('range corrente invalido'); err.statusCode = 400; throw err;
  }
  switch (compareWith) {
    case 'previous_period': {
      // Janela imediatamente anterior do mesmo tamanho (em dias).
      const dayMs = 86400000;
      const days = Math.round((ce - cs) / dayMs);
      const prevEnd = new Date(cs.getTime() - dayMs);
      const prevStart = new Date(prevEnd.getTime() - days * dayMs);
      return { start: isoDate(prevStart), end: isoDate(prevEnd) };
    }
    case 'yoy': {
      // Mesmo intervalo 1 ano antes (preserva dia/mes).
      const prevStart = new Date(cs.getFullYear() - 1, cs.getMonth(), cs.getDate());
      const prevEnd = new Date(ce.getFullYear() - 1, ce.getMonth(), ce.getDate());
      return { start: isoDate(prevStart), end: isoDate(prevEnd) };
    }
    case 'custom': {
      if (!customCompareStart || !customCompareEnd) {
        const err = new Error('compareWith=custom requer compareStart e compareEnd');
        err.statusCode = 400;
        throw err;
      }
      return { start: customCompareStart, end: customCompareEnd };
    }
    default: {
      const err = new Error('compareWith invalido: ' + compareWith);
      err.statusCode = 400;
      throw err;
    }
  }
}

async function fetchDailySeries(companyIds, start, end) {
  // generate_series + LEFT JOIN garante que dias sem transacao aparecem com 0,
  // crucial pro grafico sobreposto (linha continua, sem buracos).
  const sql = `
    SELECT
      d.day::date AS date,
      COALESCE(SUM(CASE WHEN t.type='income' AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS income,
      COALESCE(SUM(CASE WHEN t.type='expense' AND t.status='confirmed' THEN t.amount ELSE 0 END), 0) AS expenses
    FROM generate_series($2::date, $3::date, '1 day') AS d(day)
    LEFT JOIN transactions t
      ON t.company_id = ANY($1::uuid[])
      AND COALESCE(t.due_date, t.created_at::date) = d.day::date
    GROUP BY d.day
    ORDER BY d.day
  `;
  const r = await db.query(sql, [companyIds, start, end]);
  return r.rows.map((row) => {
    const inc = parseFloat(row.income) || 0;
    const exp = parseFloat(row.expenses) || 0;
    const dateRaw = row.date;
    const dateStr = dateRaw && dateRaw.toISOString
      ? dateRaw.toISOString().slice(0, 10)
      : String(dateRaw).slice(0, 10);
    return { date: dateStr, income: inc, expenses: exp, net: inc - exp };
  });
}

function aggregateTotals(daily) {
  let income = 0, expenses = 0;
  daily.forEach((d) => { income += d.income; expenses += d.expenses; });
  return { income, expenses, net: income - expenses };
}

function pct(a, b) {
  // null = sem comparativo valido (base zero). 0 = igual. positivo/negativo = variacao.
  if (b === 0) return a === 0 ? 0 : null;
  return ((a - b) / Math.abs(b)) * 100;
}

function computeDelta(currentTotals, previousTotals) {
  return {
    income_pct: pct(currentTotals.income, previousTotals.income),
    expenses_pct: pct(currentTotals.expenses, previousTotals.expenses),
    net_pct: pct(currentTotals.net, previousTotals.net),
  };
}

async function computeComparative(companyIds, opts) {
  const current = resolveCurrentRange(opts.period, opts.customStart, opts.customEnd);
  const compare = resolveCompareRange(opts.compareWith, current, opts.customCompareStart, opts.customCompareEnd);

  const [currentDaily, compareDaily] = await Promise.all([
    fetchDailySeries(companyIds, current.start, current.end),
    fetchDailySeries(companyIds, compare.start, compare.end),
  ]);

  const currentTotals = aggregateTotals(currentDaily);
  const compareTotals = aggregateTotals(compareDaily);
  const delta = computeDelta(currentTotals, compareTotals);

  return {
    current:  { start: current.start, end: current.end, label: formatRangeLabel(current.start, current.end), daily: currentDaily, totals: currentTotals },
    previous: { start: compare.start, end: compare.end, label: formatRangeLabel(compare.start, compare.end), daily: compareDaily, totals: compareTotals },
    delta,
  };
}

// ── Per-company router ──────────────────────────────────────
const companyRouter = express.Router({ mergeParams: true });

companyRouter.get('/comparative', async (req, res) => {
  try {
    const cid = req.params.id;
    const opts = {
      period: req.query.period || 'month',
      compareWith: req.query.compareWith || 'previous_period',
      customStart: req.query.start,
      customEnd: req.query.end,
      customCompareStart: req.query.compareStart,
      customCompareEnd: req.query.compareEnd,
    };
    const out = await computeComparative([cid], opts);
    out.consolidated = false;
    res.json(out);
  } catch (err) {
    console.error('[financeiroComparative/company] error:', err.message);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Erro ao calcular comparativo' });
  }
});

// ── Multi-CNPJ /me router ───────────────────────────────────
const meRouter = express.Router();
meRouter.use(requireAuth);

meRouter.get('/comparative', async (req, res) => {
  try {
    const userId = req.user && req.user.id;
    if (!userId) return res.status(401).json({ error: 'Nao autenticado' });

    const companiesRes = await db.query(
      `SELECT company_id FROM company_users WHERE user_id = $1`,
      [userId]
    );
    const companyIds = companiesRes.rows.map((r) => r.company_id);

    const opts = {
      period: req.query.period || 'month',
      compareWith: req.query.compareWith || 'previous_period',
      customStart: req.query.start,
      customEnd: req.query.end,
      customCompareStart: req.query.compareStart,
      customCompareEnd: req.query.compareEnd,
    };

    if (companyIds.length === 0) {
      return res.json({
        current: { start: '', end: '', label: '', daily: [], totals: { income: 0, expenses: 0, net: 0 } },
        previous: { start: '', end: '', label: '', daily: [], totals: { income: 0, expenses: 0, net: 0 } },
        delta: { income_pct: null, expenses_pct: null, net_pct: null },
        consolidated: true,
        company_count: 0,
      });
    }

    const out = await computeComparative(companyIds, opts);
    out.consolidated = true;
    out.company_count = companyIds.length;
    res.json(out);
  } catch (err) {
    console.error('[financeiroComparative/me] error:', err.message);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Erro ao calcular comparativo consolidado' });
  }
});

module.exports = { companyRouter, meRouter };
