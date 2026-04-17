// ============================================================
// AURA. — Central de Comando: Revenue Intelligence (Sprint 3)
//
// GET /admin/metrics/mrr-waterfall  — New + Expansion - Churn - Contraction
// GET /admin/metrics/unit-economics — LTV, CAC, LTV/CAC
// GET /admin/metrics/forecast       — Projecao 3/6/12 meses
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const adminOnly = [requireAuth, requireRole('admin')];
const PLAN_PRICES = { essencial: 89, negocio: 199, expansao: 299 };

// ── GET /admin/metrics/mrr-waterfall ────────────────────────────
router.get('/metrics/mrr-waterfall', ...adminOnly, asyncHandler(async (req, res) => {
  // Mes atual — calcula componentes do MRR
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  // MRR anterior (snapshot ou calculo)
  const { rows: prevSnap } = await pool.query(
    `SELECT mrr_total FROM aura_revenue_snapshot WHERE reference_month < $1 ORDER BY reference_month DESC LIMIT 1`,
    [startOfMonth]
  );
  const prevMRR = parseFloat(prevSnap[0]?.mrr_total || 0);

  // MRR atual
  const { rows: planCounts } = await pool.query(
    `SELECT plan, COUNT(*) FILTER(WHERE billing_status='active') AS paying FROM companies WHERE is_active=true GROUP BY plan`
  );
  let currentMRR = 0;
  planCounts.forEach(r => { currentMRR += (parseInt(r.paying) || 0) * (PLAN_PRICES[r.plan] || 0); });

  // New MRR (clientes criados este mes que estao pagando)
  const { rows: newRows } = await pool.query(
    `SELECT plan, COUNT(*) AS n FROM companies WHERE is_active=true AND billing_status='active' AND created_at >= $1 GROUP BY plan`,
    [startOfMonth]
  );
  let newMRR = 0;
  newRows.forEach(r => { newMRR += (parseInt(r.n) || 0) * (PLAN_PRICES[r.plan] || 0); });

  // Churn MRR (eventos de churn este mes)
  const { rows: churnRows } = await pool.query(
    `SELECT COALESCE(SUM(mrr_lost), 0) AS total FROM churn_events WHERE created_at >= $1`,
    [startOfMonth]
  );
  const churnMRR = parseFloat(churnRows[0]?.total || 0);

  // Expansion = crescimento alem de new (upgrade de plano)
  // Simplificado: currentMRR - prevMRR - newMRR + churnMRR
  const expansionMRR = Math.max(0, currentMRR - prevMRR - newMRR + churnMRR);
  const contractionMRR = Math.max(0, -(currentMRR - prevMRR - newMRR + churnMRR - expansionMRR));

  res.json({
    period: { start: startOfMonth.toISOString(), end: now.toISOString() },
    previous_mrr: prevMRR,
    current_mrr: currentMRR,
    new_mrr: newMRR,
    expansion_mrr: expansionMRR,
    churn_mrr: churnMRR,
    contraction_mrr: contractionMRR,
    net_change: currentMRR - prevMRR,
    net_revenue_retention: prevMRR > 0 ? Math.round(((currentMRR - newMRR) / prevMRR) * 1000) / 10 : 100,
  });
}));

// ── GET /admin/metrics/unit-economics ───────────────────────────
router.get('/metrics/unit-economics', ...adminOnly, asyncHandler(async (req, res) => {
  // Clientes pagantes
  const { rows: clients } = await pool.query(
    `SELECT COUNT(*) AS paying FROM companies WHERE is_active=true AND billing_status='active'`
  );
  const payingClients = parseInt(clients[0]?.paying || 0);

  // MRR
  const { rows: planCounts } = await pool.query(
    `SELECT plan, COUNT(*) AS n FROM companies WHERE is_active=true AND billing_status='active' GROUP BY plan`
  );
  let mrr = 0;
  planCounts.forEach(r => { mrr += (parseInt(r.n) || 0) * (PLAN_PRICES[r.plan] || 0); });
  const arpu = payingClients > 0 ? mrr / payingClients : 0;

  // Churn rate mensal (media ultimos 3 meses ou estimativa)
  const { rows: churnHistory } = await pool.query(
    `SELECT COUNT(*) AS total FROM churn_events WHERE created_at >= NOW() - INTERVAL '90 days'`
  );
  const churnCount3m = parseInt(churnHistory[0]?.total || 0);
  const monthlyChurnRate = payingClients > 0 ? (churnCount3m / 3) / payingClients : 0.05; // fallback 5%
  const churnPct = Math.round(monthlyChurnRate * 1000) / 10;

  // LTV = ARPU / churn rate mensal
  const ltv = monthlyChurnRate > 0 ? arpu / monthlyChurnRate : arpu * 24;
  const ltvMonths = monthlyChurnRate > 0 ? Math.round(1 / monthlyChurnRate) : 24;

  // CAC (custo de aquisicao — marketing dividido por novos clientes)
  // Custos de marketing dos ultimos 3 meses
  const { rows: mktCosts } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM aura_operational_costs WHERE category='marketing' AND reference_month >= NOW() - INTERVAL '90 days'`
  );
  const mktSpend3m = parseFloat(mktCosts[0]?.total || 0);
  const { rows: newClients3m } = await pool.query(
    `SELECT COUNT(*) AS total FROM companies WHERE is_active=true AND created_at >= NOW() - INTERVAL '90 days'`
  );
  const newCount3m = parseInt(newClients3m[0]?.total || 0);
  const cac = newCount3m > 0 ? mktSpend3m / newCount3m : 0;
  const ltvCacRatio = cac > 0 ? Math.round((ltv / cac) * 10) / 10 : null;

  // Custos por categoria
  const { rows: costBreakdown } = await pool.query(
    `SELECT category, COALESCE(SUM(amount),0) AS total FROM aura_operational_costs
     WHERE reference_month >= date_trunc('month', NOW())
     GROUP BY category ORDER BY total DESC`
  );

  // Margem bruta
  const totalCosts = costBreakdown.reduce((s, r) => s + parseFloat(r.total), 0);
  const grossMargin = mrr - totalCosts;
  const marginPct = mrr > 0 ? Math.round((grossMargin / mrr) * 100) : 0;

  res.json({
    paying_clients: payingClients,
    mrr, arpu: Math.round(arpu * 100) / 100,
    churn: { rate_pct: churnPct, count_3m: churnCount3m },
    ltv: { value: Math.round(ltv), months: ltvMonths },
    cac: { value: Math.round(cac * 100) / 100, marketing_spend_3m: mktSpend3m, new_clients_3m: newCount3m },
    ltv_cac_ratio: ltvCacRatio,
    costs: {
      total: totalCosts,
      breakdown: costBreakdown.map(r => ({ category: r.category, amount: parseFloat(r.total) })),
    },
    margin: { gross: grossMargin, pct: marginPct },
  });
}));

// ── GET /admin/metrics/forecast ────────────────────────────────
router.get('/metrics/forecast', ...adminOnly, asyncHandler(async (req, res) => {
  // MRR atual
  const { rows: planCounts } = await pool.query(
    `SELECT plan, COUNT(*) FILTER(WHERE billing_status='active') AS paying FROM companies WHERE is_active=true GROUP BY plan`
  );
  let currentMRR = 0;
  planCounts.forEach(r => { currentMRR += (parseInt(r.paying) || 0) * (PLAN_PRICES[r.plan] || 0); });

  // Growth rate (media dos snapshots)
  const { rows: snapshots } = await pool.query(
    `SELECT mrr_total FROM aura_revenue_snapshot ORDER BY reference_month DESC LIMIT 3`
  );
  let growthRate = 0.15; // fallback 15% mensal
  if (snapshots.length >= 2) {
    const rates = [];
    for (let i = 0; i < snapshots.length - 1; i++) {
      const curr = parseFloat(snapshots[i].mrr_total);
      const prev = parseFloat(snapshots[i + 1].mrr_total);
      if (prev > 0) rates.push((curr - prev) / prev);
    }
    if (rates.length > 0) growthRate = rates.reduce((s, r) => s + r, 0) / rates.length;
  }

  // Projecoes
  const projections = [];
  let projected = currentMRR;
  for (let m = 1; m <= 12; m++) {
    projected = projected * (1 + growthRate);
    projections.push({ month: m, mrr: Math.round(projected), arr: Math.round(projected * 12) });
  }

  res.json({
    current_mrr: currentMRR,
    growth_rate_pct: Math.round(growthRate * 1000) / 10,
    projections,
    milestones: {
      mrr_1k: projections.find(p => p.mrr >= 1000)?.month || null,
      mrr_5k: projections.find(p => p.mrr >= 5000)?.month || null,
      mrr_10k: projections.find(p => p.mrr >= 10000)?.month || null,
    },
  });
}));

module.exports = router;
