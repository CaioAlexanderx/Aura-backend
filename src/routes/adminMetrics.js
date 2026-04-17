// ============================================================
// AURA. — Central de Comando: Metrics + Alerts (Sprint 1)
//
// GET /admin/metrics/overview    — KPIs completos
// GET /admin/metrics/mrr-trend   — Serie temporal MRR 12 meses
// GET /admin/alerts              — Alertas operacionais
// POST /admin/health/recalculate — Recalcula health scores
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const adminOnly = [requireAuth, requireRole('admin')];

const PLAN_PRICES = { essencial: 89, negocio: 199, expansao: 299 };

// ── GET /admin/metrics/overview ──────────────────────────────────
router.get('/metrics/overview', ...adminOnly, asyncHandler(async (req, res) => {
  // Clientes ativos por plano
  const { rows: planCounts } = await pool.query(
    `SELECT plan, COUNT(*) AS total, 
       COUNT(*) FILTER(WHERE billing_status='active') AS paying,
       COUNT(*) FILTER(WHERE billing_status='trial') AS trial,
       COUNT(*) FILTER(WHERE billing_status IN ('pending','overdue')) AS overdue
     FROM companies WHERE is_active=true GROUP BY plan`
  );
  const counts = { essencial: 0, negocio: 0, expansao: 0, personalizado: 0 };
  const paying = { essencial: 0, negocio: 0, expansao: 0 };
  let totalTrial = 0, totalOverdue = 0;
  planCounts.forEach(r => {
    counts[r.plan] = parseInt(r.total);
    paying[r.plan] = parseInt(r.paying);
    totalTrial += parseInt(r.trial);
    totalOverdue += parseInt(r.overdue);
  });
  const totalClients = Object.values(counts).reduce((s, v) => s + v, 0);
  const totalPaying = Object.values(paying).reduce((s, v) => s + v, 0);

  // MRR real (baseado em paying clients)
  const mrrByPlan = {
    essencial: paying.essencial * PLAN_PRICES.essencial,
    negocio: paying.negocio * PLAN_PRICES.negocio,
    expansao: paying.expansao * PLAN_PRICES.expansao,
  };
  const mrrTotal = mrrByPlan.essencial + mrrByPlan.negocio + mrrByPlan.expansao;
  const arpu = totalPaying > 0 ? Math.round((mrrTotal / totalPaying) * 100) / 100 : 0;

  // MRR mes anterior (do snapshot)
  const { rows: prevSnap } = await pool.query(
    `SELECT mrr_total FROM aura_revenue_snapshot ORDER BY reference_month DESC LIMIT 1`
  );
  const prevMRR = parseFloat(prevSnap[0]?.mrr_total || 0);
  const mrrGrowth = prevMRR > 0 ? Math.round(((mrrTotal - prevMRR) / prevMRR) * 1000) / 10 : 0;

  // Churn (cancelamentos no mes)
  const { rows: churnRows } = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(mrr_lost),0) AS mrr_lost
     FROM churn_events
     WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')`
  );
  const churnCount = parseInt(churnRows[0]?.total || 0);
  const churnMRR = parseFloat(churnRows[0]?.mrr_lost || 0);
  const churnRate = totalClients > 0 ? Math.round((churnCount / totalClients) * 1000) / 10 : 0;

  // Custos do mes
  const firstOfMonth = new Date();
  firstOfMonth.setDate(1); firstOfMonth.setHours(0,0,0,0);
  const { rows: costRows } = await pool.query(
    `SELECT COALESCE(SUM(amount),0) AS total FROM aura_operational_costs WHERE reference_month >= $1`,
    [firstOfMonth]
  );
  const totalCosts = parseFloat(costRows[0]?.total || 0);
  const grossMargin = mrrTotal - totalCosts;
  const marginPct = mrrTotal > 0 ? Math.round((grossMargin / mrrTotal) * 100) : 0;

  // Meta do mes
  const { rows: goalRows } = await pool.query(
    `SELECT * FROM aura_monthly_goals WHERE reference_month = date_trunc('month', NOW())::date LIMIT 1`
  );
  const goal = goalRows[0] || null;

  // Novos clientes este mes
  const { rows: newRows } = await pool.query(
    `SELECT COUNT(*) AS total FROM companies WHERE is_active=true AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')`
  );
  const newThisMonth = parseInt(newRows[0]?.total || 0);

  // Metricas de uso agregado
  const { rows: usageRows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM transactions WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')) AS tx_month,
       (SELECT COUNT(*) FROM sales WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'America/Sao_Paulo')) AS sales_month,
       (SELECT COUNT(*) FROM products) AS total_products,
       (SELECT COUNT(*) FROM customers) AS total_customers`
  );
  const usage = usageRows[0] || {};

  res.json({
    timestamp: new Date().toISOString(),
    clients: {
      total: totalClients, paying: totalPaying, trial: totalTrial,
      overdue: totalOverdue, new_this_month: newThisMonth,
      by_plan: counts,
    },
    mrr: {
      total: mrrTotal, by_plan: mrrByPlan,
      growth_pct: mrrGrowth, previous: prevMRR,
      arr: mrrTotal * 12,
    },
    arpu,
    churn: { count: churnCount, mrr_lost: churnMRR, rate_pct: churnRate },
    costs: { current_month: totalCosts },
    margin: { gross: grossMargin, pct: marginPct },
    goal: goal ? {
      mrr_target: parseFloat(goal.mrr_target || 0),
      clients_target: parseInt(goal.clients_target || 0),
      mrr_progress: goal.mrr_target ? Math.round((mrrTotal / parseFloat(goal.mrr_target)) * 100) : null,
      clients_progress: goal.clients_target ? Math.round((totalClients / parseInt(goal.clients_target)) * 100) : null,
    } : null,
    usage: {
      transactions_month: parseInt(usage.tx_month || 0),
      sales_month: parseInt(usage.sales_month || 0),
      total_products: parseInt(usage.total_products || 0),
      total_customers: parseInt(usage.total_customers || 0),
    },
  });
}));

// ── GET /admin/metrics/mrr-trend ─────────────────────────────────
router.get('/metrics/mrr-trend', ...adminOnly, asyncHandler(async (req, res) => {
  const months = parseInt(req.query.months) || 12;
  const { rows } = await pool.query(
    `SELECT * FROM aura_revenue_snapshot ORDER BY reference_month DESC LIMIT $1`, [months]
  );

  // Se nao tem snapshots, gera um estimado baseado no estado atual
  if (rows.length === 0) {
    const { rows: planCounts } = await pool.query(
      `SELECT plan, COUNT(*) FILTER(WHERE billing_status='active') AS paying FROM companies WHERE is_active=true GROUP BY plan`
    );
    const now = new Date();
    const current = { month: now.toISOString().slice(0,7), essencial: 0, negocio: 0, expansao: 0 };
    planCounts.forEach(r => { current[r.plan] = parseInt(r.paying || 0); });
    const mrr = current.essencial * PLAN_PRICES.essencial + current.negocio * PLAN_PRICES.negocio + current.expansao * PLAN_PRICES.expansao;
    return res.json({ months: [{ month: current.month, mrr_total: mrr, clients_total: current.essencial + current.negocio + current.expansao }] });
  }

  res.json({
    months: rows.reverse().map(r => ({
      month: r.reference_month?.toISOString?.()?.slice(0,7) || r.reference_month,
      mrr_total: parseFloat(r.mrr_total || 0),
      mrr_essencial: parseFloat(r.mrr_essencial || 0),
      mrr_negocio: parseFloat(r.mrr_negocio || 0),
      mrr_expansao: parseFloat(r.mrr_expansao || 0),
      clients_total: parseInt(r.clients_total || 0),
      gross_margin: parseFloat(r.gross_margin || 0),
    })),
  });
}));

// ── GET /admin/alerts ────────────────────────────────────────────
router.get('/alerts', ...adminOnly, asyncHandler(async (req, res) => {
  const alerts = [];

  // 1. Trials expirando em <= 3 dias
  const { rows: trialRows } = await pool.query(
    `SELECT c.id, c.trade_name, c.legal_name, c.trial_ends_at, u.email, u.full_name
     FROM companies c LEFT JOIN users u ON u.id=c.owner_id
     WHERE c.is_active=true AND c.billing_status='trial'
       AND c.trial_ends_at IS NOT NULL
       AND c.trial_ends_at <= NOW() + INTERVAL '3 days'
     ORDER BY c.trial_ends_at ASC`
  );
  trialRows.forEach(r => {
    const daysLeft = Math.ceil((new Date(r.trial_ends_at) - new Date()) / 86400000);
    alerts.push({
      type: 'trial_expiring', priority: 'critical',
      company_id: r.id, company_name: r.trade_name || r.legal_name,
      contact: r.email, contact_name: r.full_name,
      message: `Trial expira em ${daysLeft <= 0 ? 'HOJE' : daysLeft + ' dia(s)'}`,
      expires_at: r.trial_ends_at, days_left: daysLeft,
      action: 'Contatar para conversao',
    });
  });

  // 2. Pagamentos pendentes/vencidos
  const { rows: overdueRows } = await pool.query(
    `SELECT c.id, c.trade_name, c.legal_name, c.plan, c.billing_status, c.next_billing_date, u.email
     FROM companies c LEFT JOIN users u ON u.id=c.owner_id
     WHERE c.is_active=true AND c.billing_status IN ('pending','overdue')
       AND c.plan != 'essencial'
     ORDER BY c.next_billing_date ASC`
  );
  overdueRows.forEach(r => {
    const daysPast = r.next_billing_date ? Math.ceil((new Date() - new Date(r.next_billing_date)) / 86400000) : 0;
    alerts.push({
      type: 'payment_overdue', priority: daysPast > 7 ? 'critical' : 'high',
      company_id: r.id, company_name: r.trade_name || r.legal_name,
      contact: r.email, plan: r.plan,
      message: `Pagamento ${r.billing_status === 'overdue' ? 'vencido' : 'pendente'}${daysPast > 0 ? ' ha ' + daysPast + ' dia(s)' : ''}`,
      action: 'Enviar cobranca',
    });
  });

  // 3. Clientes inativos (sem transacao > 14 dias)
  const { rows: inactiveRows } = await pool.query(
    `SELECT c.id, c.trade_name, c.legal_name, c.plan, u.email,
       (SELECT MAX(created_at) FROM transactions WHERE company_id=c.id) AS last_tx,
       c.last_active_at
     FROM companies c LEFT JOIN users u ON u.id=c.owner_id
     WHERE c.is_active=true AND c.billing_status NOT IN ('trial','cancelled')
     ORDER BY c.created_at`
  );
  inactiveRows.forEach(r => {
    const lastActivity = r.last_active_at || r.last_tx;
    if (!lastActivity) return;
    const daysSince = Math.ceil((new Date() - new Date(lastActivity)) / 86400000);
    if (daysSince >= 14) {
      alerts.push({
        type: 'client_inactive', priority: daysSince >= 30 ? 'high' : 'medium',
        company_id: r.id, company_name: r.trade_name || r.legal_name,
        contact: r.email, plan: r.plan,
        message: `Inativo ha ${daysSince} dias`,
        days_inactive: daysSince,
        action: 'Check-in proativo',
      });
    }
  });

  // 4. Health scores criticos
  const { rows: healthRows } = await pool.query(
    `SELECT h.company_id, h.score, h.risk_level, c.trade_name, c.legal_name, u.email
     FROM client_health_scores h
     JOIN companies c ON c.id=h.company_id
     LEFT JOIN users u ON u.id=c.owner_id
     WHERE h.score < 30 AND c.is_active=true
     ORDER BY h.score ASC`
  );
  healthRows.forEach(r => {
    alerts.push({
      type: 'health_critical', priority: r.score < 15 ? 'critical' : 'high',
      company_id: r.company_id, company_name: r.trade_name || r.legal_name,
      contact: r.email, score: r.score, risk_level: r.risk_level,
      message: `Health score ${r.score}/100 (${r.risk_level})`,
      action: 'Reuniao de retencao',
    });
  });

  // 5. Tickets sem resposta > 4h
  const { rows: ticketRows } = await pool.query(
    `SELECT t.id, t.subject, t.status, t.created_at, c.trade_name, c.legal_name
     FROM support_tickets t
     JOIN companies c ON c.id=t.company_id
     WHERE t.status='open' AND t.created_at < NOW() - INTERVAL '4 hours'
     ORDER BY t.created_at ASC`
  ).catch(() => ({ rows: [] }));
  ticketRows.forEach(r => {
    const hoursOpen = Math.round((new Date() - new Date(r.created_at)) / 3600000);
    alerts.push({
      type: 'ticket_no_response', priority: hoursOpen > 24 ? 'high' : 'medium',
      company_name: r.trade_name || r.legal_name,
      ticket_id: r.id, subject: r.subject,
      message: `Ticket aberto ha ${hoursOpen}h sem resposta`,
      action: 'Responder ticket',
    });
  });

  // Ordenar por prioridade
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  alerts.sort((a, b) => (priorityOrder[a.priority] || 9) - (priorityOrder[b.priority] || 9));

  res.json({
    total: alerts.length,
    critical: alerts.filter(a => a.priority === 'critical').length,
    high: alerts.filter(a => a.priority === 'high').length,
    medium: alerts.filter(a => a.priority === 'medium').length,
    alerts,
  });
}));

// ── POST /admin/health/recalculate ──────────────────────────────
router.post('/health/recalculate', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: companies } = await pool.query(
    `SELECT c.id, c.plan, c.billing_status, c.last_active_at,
       (SELECT MAX(created_at) FROM transactions WHERE company_id=c.id) AS last_tx,
       (SELECT COUNT(*) FROM transactions WHERE company_id=c.id AND created_at >= NOW() - INTERVAL '30 days') AS tx_30d
     FROM companies c WHERE c.is_active=true`
  );

  let updated = 0;
  for (const c of companies) {
    // Activity score (0-25)
    const lastActive = c.last_active_at || c.last_tx;
    let activityScore = 0;
    if (lastActive) {
      const days = Math.ceil((new Date() - new Date(lastActive)) / 86400000);
      if (days <= 7) activityScore = 25;
      else if (days <= 14) activityScore = 15;
      else if (days <= 30) activityScore = 5;
    }

    // Usage score (0-25)
    const txCount = parseInt(c.tx_30d || 0);
    let usageScore = 0;
    if (txCount >= 20) usageScore = 25;
    else if (txCount >= 10) usageScore = 20;
    else if (txCount >= 5) usageScore = 10;
    else if (txCount >= 1) usageScore = 5;

    // Payment score (0-25)
    let paymentScore = 0;
    if (c.billing_status === 'active') paymentScore = 25;
    else if (c.billing_status === 'pending') paymentScore = 10;
    else if (c.billing_status === 'trial') paymentScore = 15;

    // Adoption score (0-25) — baseado no plano como proxy
    let adoptionScore = 0;
    if (c.plan === 'expansao') adoptionScore = 25;
    else if (c.plan === 'negocio') adoptionScore = 15;
    else if (c.plan === 'essencial') adoptionScore = 5;

    const score = activityScore + usageScore + paymentScore + adoptionScore;
    const riskLevel = score >= 70 ? 'healthy' : score >= 40 ? 'attention' : score >= 20 ? 'at_risk' : 'critical';

    await pool.query(
      `INSERT INTO client_health_scores (company_id, score, activity_score, usage_score, payment_score, adoption_score, risk_level, last_login, calculated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (company_id) DO UPDATE SET score=$2, activity_score=$3, usage_score=$4, payment_score=$5, adoption_score=$6, risk_level=$7, last_login=$8, calculated_at=NOW()`,
      [c.id, score, activityScore, usageScore, paymentScore, adoptionScore, riskLevel, lastActive || null]
    );
    updated++;
  }

  res.json({ message: `Health scores recalculados para ${updated} empresas`, updated });
}));

// ── POST /admin/goals ───────────────────────────────────────────
router.post('/goals', ...adminOnly, asyncHandler(async (req, res) => {
  const { reference_month, mrr_target, clients_target, churn_target, consultoria_target, notes } = req.body;
  if (!reference_month) return res.status(400).json({ error: 'reference_month obrigatorio' });
  const { rows } = await pool.query(
    `INSERT INTO aura_monthly_goals (reference_month, mrr_target, clients_target, churn_target, consultoria_target, notes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (reference_month) DO UPDATE SET mrr_target=$2, clients_target=$3, churn_target=$4, consultoria_target=$5, notes=$6, updated_at=NOW()
     RETURNING *`,
    [reference_month, mrr_target||null, clients_target||null, churn_target||null, consultoria_target||null, notes||null]
  );
  res.status(201).json({ goal: rows[0] });
}));

router.get('/goals', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM aura_monthly_goals ORDER BY reference_month DESC LIMIT 12`);
  res.json({ goals: rows });
}));

module.exports = router;
