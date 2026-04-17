// ============================================================
// AURA. — Central de Comando: Produto + Crescimento (Sprint 5)
//
// GET /admin/metrics/feature-adoption  — Heatmap modulo x empresa
// GET /admin/metrics/geography         — Distribuicao geografica
// GET /admin/metrics/verticals         — Distribuicao por vertical
// GET /admin/metrics/funnel            — Funil aquisicao
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const adminOnly = [requireAuth, requireRole('admin')];

// — GET /admin/metrics/feature-adoption ——————————————————
router.get('/metrics/feature-adoption', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: companies } = await pool.query(
    `SELECT c.id, c.trade_name, c.legal_name, c.plan FROM companies c WHERE c.is_active=true ORDER BY c.created_at`
  );

  const modules = ['financeiro','pdv','estoque','crm','folha','contabilidade','nfe','canal','ia','agendamento'];
  const matrix = [];

  for (const c of companies) {
    const usage = {};
    // Financeiro
    const { rows: txR } = await pool.query('SELECT COUNT(*) AS n FROM transactions WHERE company_id=$1', [c.id]);
    usage.financeiro = parseInt(txR[0]?.n) > 0;
    // PDV
    const { rows: sR } = await pool.query('SELECT COUNT(*) AS n FROM sales WHERE company_id=$1', [c.id]);
    usage.pdv = parseInt(sR[0]?.n) > 0;
    // Estoque
    const { rows: pR } = await pool.query('SELECT COUNT(*) AS n FROM products WHERE company_id=$1', [c.id]);
    usage.estoque = parseInt(pR[0]?.n) > 0;
    // CRM
    const { rows: cR } = await pool.query('SELECT COUNT(*) AS n FROM customers WHERE company_id=$1', [c.id]);
    usage.crm = parseInt(cR[0]?.n) > 0;
    // Folha
    const { rows: eR } = await pool.query('SELECT COUNT(*) AS n FROM employees WHERE company_id=$1', [c.id]);
    usage.folha = parseInt(eR[0]?.n) > 0;
    // Contabilidade
    const { rows: oR } = await pool.query('SELECT COUNT(*) AS n FROM fiscal_obligations WHERE company_id=$1', [c.id]).catch(() => ({ rows: [{ n: 0 }] }));
    usage.contabilidade = parseInt(oR[0]?.n) > 0;
    // NF-e (fiscal_obligations como proxy)
    usage.nfe = usage.contabilidade;
    // Canal Digital
    const { rows: dR } = await pool.query('SELECT COUNT(*) AS n FROM digital_channel_config WHERE company_id=$1', [c.id]).catch(() => ({ rows: [{ n: 0 }] }));
    usage.canal = parseInt(dR[0]?.n) > 0;
    // IA
    const { rows: aR } = await pool.query('SELECT COUNT(*) AS n FROM ai_activity_log WHERE company_id=$1', [c.id]).catch(() => ({ rows: [{ n: 0 }] }));
    usage.ia = parseInt(aR[0]?.n) > 0;
    // Agendamento
    usage.agendamento = false; // sem tabela especifica ainda

    const adoptedCount = modules.filter(m => usage[m]).length;
    matrix.push({
      company_id: c.id, name: c.trade_name || c.legal_name || '?', plan: c.plan,
      usage, adopted_count: adoptedCount, adoption_pct: Math.round((adoptedCount / modules.length) * 100),
    });
  }

  // Agregado por modulo
  const byModule = modules.map(m => ({
    module: m, adopters: matrix.filter(c => c.usage[m]).length,
    adoption_pct: matrix.length > 0 ? Math.round((matrix.filter(c => c.usage[m]).length / matrix.length) * 100) : 0,
  })).sort((a, b) => b.adopters - a.adopters);

  res.json({ total_companies: matrix.length, modules, matrix, by_module: byModule });
}));

// — GET /admin/metrics/geography ——————————————————
router.get('/metrics/geography', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT city, state, COUNT(*) AS total FROM companies WHERE is_active=true AND city IS NOT NULL GROUP BY city, state ORDER BY total DESC`
  );
  // Fallback: se nao tem city, agrupa por regime
  const { rows: regimes } = await pool.query(
    `SELECT tax_regime, COUNT(*) AS total FROM companies WHERE is_active=true GROUP BY tax_regime ORDER BY total DESC`
  );
  res.json({
    by_city: rows,
    by_regime: regimes.map(r => ({ regime: r.tax_regime || 'indefinido', count: parseInt(r.total) })),
    total_cities: rows.length,
  });
}));

// — GET /admin/metrics/verticals ——————————————————
router.get('/metrics/verticals', ...adminOnly, asyncHandler(async (req, res) => {
  // Detectar verticais ativas por empresa (via module_overrides ou dados)
  const { rows: companies } = await pool.query(
    `SELECT c.id, c.plan, c.module_overrides, c.trade_name,
       (SELECT COUNT(*) FROM barbershop_professionals WHERE company_id=c.id) AS barber_data,
       (SELECT COUNT(*) FROM barbershop_appointments WHERE company_id=c.id) AS barber_appts
     FROM companies c WHERE c.is_active=true`
  ).catch(() => ({ rows: [] }));

  const verticals = { sem_vertical: 0, barbearia: 0, dental: 0, food: 0, salao: 0, estetica: 0, pet: 0 };
  companies.forEach(c => {
    const overrides = c.module_overrides || {};
    if (parseInt(c.barber_data) > 0 || overrides.barber) verticals.barbearia++;
    else if (overrides.dental) verticals.dental++;
    else if (overrides.food) verticals.food++;
    else verticals.sem_vertical++;
  });

  const { rows: planDist } = await pool.query(
    `SELECT plan, COUNT(*) AS total FROM companies WHERE is_active=true GROUP BY plan ORDER BY total DESC`
  );

  res.json({
    verticals: Object.entries(verticals).filter(([,v]) => v > 0).map(([k, v]) => ({ vertical: k, count: v })),
    by_plan: planDist.map(r => ({ plan: r.plan, count: parseInt(r.total) })),
  });
}));

// — GET /admin/metrics/funnel ——————————————————
router.get('/metrics/funnel', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: total } = await pool.query('SELECT COUNT(*) AS n FROM users');
  const { rows: withCompany } = await pool.query('SELECT COUNT(DISTINCT owner_id) AS n FROM companies');
  const { rows: trial } = await pool.query(`SELECT COUNT(*) AS n FROM companies WHERE billing_status='trial' AND is_active=true`);
  const { rows: paying } = await pool.query(`SELECT COUNT(*) AS n FROM companies WHERE billing_status='active' AND is_active=true`);
  const { rows: churned } = await pool.query(`SELECT COUNT(*) AS n FROM companies WHERE is_active=false OR billing_status='cancelled'`);

  const signups = parseInt(total[0]?.n || 0);
  const companies_created = parseInt(withCompany[0]?.n || 0);
  const trialCount = parseInt(trial[0]?.n || 0);
  const paidCount = parseInt(paying[0]?.n || 0);
  const churnedCount = parseInt(churned[0]?.n || 0);

  res.json({
    funnel: [
      { stage: 'Signup', count: signups, pct: 100 },
      { stage: 'Empresa criada', count: companies_created, pct: signups > 0 ? Math.round((companies_created/signups)*100) : 0 },
      { stage: 'Trial ativo', count: trialCount, pct: signups > 0 ? Math.round((trialCount/signups)*100) : 0 },
      { stage: 'Pagante', count: paidCount, pct: signups > 0 ? Math.round((paidCount/signups)*100) : 0 },
    ],
    churned: churnedCount,
    conversion_rate: signups > 0 ? Math.round((paidCount/signups)*100) : 0,
  });
}));

module.exports = router;
