// ============================================================
// AURA. — Central de Comando: Client 360° (Sprint 2)
//
// GET /admin/clients/:cid/health   — Health score breakdown
// GET /admin/clients/:cid/activity — Uso por modulo + ultimas acoes
// GET /admin/clients/:cid/billing  — Faturas e status de pagamento
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

// ── GET /admin/clients/:cid/health ─────────────────────────────
router.get('/clients/:cid/health', ...adminOnly, asyncHandler(async (req, res) => {
  const { cid } = req.params;
  const { rows: hRows } = await pool.query('SELECT * FROM client_health_scores WHERE company_id=$1', [cid]);
  const health = hRows[0] || null;

  if (!health) {
    // Calcula on-the-fly se nao existe
    const { rows: comp } = await pool.query(
      `SELECT c.id, c.plan, c.billing_status, c.last_active_at,
         (SELECT MAX(created_at) FROM transactions WHERE company_id=c.id) AS last_tx,
         (SELECT COUNT(*) FROM transactions WHERE company_id=c.id AND created_at >= NOW()-INTERVAL '30 days') AS tx_30d
       FROM companies c WHERE c.id=$1`, [cid]
    );
    if (!comp.length) throw new AppError('Empresa nao encontrada', 404);
    const c = comp[0];
    const lastActive = c.last_active_at || c.last_tx;
    const days = lastActive ? Math.ceil((new Date() - new Date(lastActive)) / 86400000) : 999;
    const txCount = parseInt(c.tx_30d || 0);
    const activity = days <= 7 ? 25 : days <= 14 ? 15 : days <= 30 ? 5 : 0;
    const usage = txCount >= 20 ? 25 : txCount >= 10 ? 20 : txCount >= 5 ? 10 : txCount >= 1 ? 5 : 0;
    const payment = c.billing_status === 'active' ? 25 : c.billing_status === 'trial' ? 15 : 10;
    const adoption = c.plan === 'expansao' ? 25 : c.plan === 'negocio' ? 15 : 5;
    const score = activity + usage + payment + adoption;
    return res.json({ company_id: cid, score, activity_score: activity, usage_score: usage, payment_score: payment, adoption_score: adoption, risk_level: score >= 70 ? 'healthy' : score >= 40 ? 'attention' : 'at_risk', last_login: lastActive, calculated_at: new Date() });
  }

  res.json(health);
}));

// ── GET /admin/clients/:cid/activity ───────────────────────────
router.get('/clients/:cid/activity', ...adminOnly, asyncHandler(async (req, res) => {
  const { cid } = req.params;

  // Metricas de uso
  const { rows: usage } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM transactions WHERE company_id=$1) AS total_transactions,
      (SELECT COUNT(*) FROM transactions WHERE company_id=$1 AND created_at >= NOW()-INTERVAL '30 days') AS tx_30d,
      (SELECT COUNT(*) FROM transactions WHERE company_id=$1 AND created_at >= NOW()-INTERVAL '7 days') AS tx_7d,
      (SELECT COUNT(*) FROM sales WHERE company_id=$1) AS total_sales,
      (SELECT COUNT(*) FROM sales WHERE company_id=$1 AND created_at >= NOW()-INTERVAL '30 days') AS sales_30d,
      (SELECT COUNT(*) FROM products WHERE company_id=$1) AS total_products,
      (SELECT COUNT(*) FROM customers WHERE company_id=$1) AS total_customers,
      (SELECT COUNT(*) FROM employees WHERE company_id=$1 AND status='active') AS active_employees,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE company_id=$1 AND type='income') AS total_revenue,
      (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE company_id=$1 AND type='income' AND created_at >= NOW()-INTERVAL '30 days') AS revenue_30d
  `, [cid]);

  // Modulos usados (baseado em dados existentes)
  const features = [];
  const u = usage[0] || {};
  if (parseInt(u.total_transactions) > 0) features.push('financeiro');
  if (parseInt(u.total_sales) > 0) features.push('pdv');
  if (parseInt(u.total_products) > 0) features.push('estoque');
  if (parseInt(u.total_customers) > 0) features.push('crm');
  if (parseInt(u.active_employees) > 0) features.push('folha');

  // Verificar uso de outros modulos
  const { rows: nfCount } = await pool.query('SELECT COUNT(*) AS n FROM fiscal_obligations WHERE company_id=$1', [cid]).catch(() => ({ rows: [{ n: 0 }] }));
  if (parseInt(nfCount[0]?.n) > 0) features.push('contabilidade');

  const { rows: aiCount } = await pool.query('SELECT COUNT(*) AS n FROM ai_activity_log WHERE company_id=$1', [cid]).catch(() => ({ rows: [{ n: 0 }] }));
  if (parseInt(aiCount[0]?.n) > 0) features.push('ia');

  // Ultimas transacoes (como proxy de atividade)
  const { rows: recentTx } = await pool.query(
    `SELECT id, type, amount, description, category, created_at FROM transactions WHERE company_id=$1 ORDER BY created_at DESC LIMIT 5`, [cid]
  );

  // Timeline de marcos
  const { rows: comp } = await pool.query('SELECT created_at, plan, billing_status, tax_regime, trade_name FROM companies WHERE id=$1', [cid]);
  const company = comp[0] || {};

  res.json({
    company_id: cid,
    company_name: company.trade_name || '',
    usage: {
      total_transactions: parseInt(u.total_transactions || 0),
      tx_30d: parseInt(u.tx_30d || 0),
      tx_7d: parseInt(u.tx_7d || 0),
      total_sales: parseInt(u.total_sales || 0),
      sales_30d: parseInt(u.sales_30d || 0),
      total_products: parseInt(u.total_products || 0),
      total_customers: parseInt(u.total_customers || 0),
      active_employees: parseInt(u.active_employees || 0),
      total_revenue: parseFloat(u.total_revenue || 0),
      revenue_30d: parseFloat(u.revenue_30d || 0),
    },
    features_used: features,
    features_count: features.length,
    recent_transactions: recentTx.map(t => ({ ...t, amount: parseFloat(t.amount) })),
    member_since: company.created_at,
    plan: company.plan,
    billing_status: company.billing_status,
    tax_regime: company.tax_regime,
  });
}));

// ── GET /admin/clients (enhanced — inclui health score) ─────────
router.get('/clients-360', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.id, c.trade_name, c.legal_name, c.plan, c.is_active,
       c.billing_status, c.billing_cycle, c.module_overrides,
       c.created_at, c.last_active_at, c.tax_regime, c.trial_ends_at,
       u.email AS owner_email, u.full_name AS owner_name,
       h.score AS health_score, h.risk_level, h.activity_score, h.usage_score, h.payment_score, h.adoption_score,
       (SELECT COUNT(*) FROM transactions WHERE company_id=c.id) AS tx_count,
       (SELECT COUNT(*) FROM products WHERE company_id=c.id) AS prod_count,
       (SELECT COUNT(*) FROM customers WHERE company_id=c.id) AS cust_count,
       (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE company_id=c.id AND type='income') AS total_revenue
    FROM companies c
    LEFT JOIN users u ON u.id=c.owner_id
    LEFT JOIN client_health_scores h ON h.company_id=c.id
    ORDER BY h.score ASC NULLS LAST, c.created_at DESC
  `);

  res.json({
    total: rows.length,
    clients: rows.map(r => ({
      ...r,
      tx_count: parseInt(r.tx_count || 0),
      prod_count: parseInt(r.prod_count || 0),
      cust_count: parseInt(r.cust_count || 0),
      total_revenue: parseFloat(r.total_revenue || 0),
      health_score: r.health_score ? parseInt(r.health_score) : null,
    })),
  });
}));

module.exports = router;
