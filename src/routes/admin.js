// ============================================================
// AURA. — Gestão Aura — Rotas Admin (BE-17/18 + FEAT-01/02)
// ============================================================

const express = require('express');
const router = express.Router();

const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { analyzeCNPJ } = require('../services/cnpjAnalysis');
const { MODULE_PLAN_MAP, getModuleMap, getVisibleModules } = require('../services/modules');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];
const analystAccess = [requireAuth, requireRole('admin', 'analyst')];

const PLAN_PRICES = {
  essencial: 99,
  negocio: 179,
  expansao: 299,
};

function normalizeProfile(profile) {
  if (!profile) return null;
  const map = {
    admin: 'admin', analyst: 'analyst', analista: 'analyst',
    support: 'support', suporte: 'support',
    finance: 'finance', financeiro: 'finance',
  };
  return map[String(profile).trim().toLowerCase()] || null;
}

// ── BE-17: Dashboard ───────────────────────────────────────────

router.get('/dashboard', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: planCounts } = await pool.query(
    `SELECT plan, COUNT(*) AS total FROM companies WHERE is_active = true GROUP BY plan`
  );
  const counts = { essencial: 0, negocio: 0, expansao: 0 };
  planCounts.forEach((r) => { counts[r.plan] = parseInt(r.total, 10); });
  const totalClients = counts.essencial + counts.negocio + counts.expansao;
  const mrrEstimated = counts.essencial * PLAN_PRICES.essencial + counts.negocio * PLAN_PRICES.negocio + counts.expansao * PLAN_PRICES.expansao;

  const { rows: snapshot } = await pool.query(`SELECT * FROM aura_revenue_snapshot ORDER BY reference_month DESC LIMIT 1`);
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const { rows: costs } = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM aura_operational_costs WHERE reference_month = $1`, [firstOfMonth]);
  const totalCosts = parseFloat(costs[0]?.total || 0);
  const grossMargin = mrrEstimated - totalCosts;

  res.json({
    reference_date: new Date().toISOString(),
    clients: { total: totalClients, essencial: counts.essencial, negocio: counts.negocio, expansao: counts.expansao },
    mrr: { estimated: mrrEstimated, last_snapshot: snapshot[0]?.mrr_total || null },
    costs: { current_month: totalCosts },
    gross_margin: { estimated: grossMargin, margin_pct: mrrEstimated > 0 ? Math.round((grossMargin / mrrEstimated) * 100) : null },
  });
}));

router.get('/revenue', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM aura_revenue_snapshot ORDER BY reference_month DESC LIMIT 12`);
  res.json({ snapshots: rows });
}));

router.post('/revenue/snapshot', ...adminOnly, asyncHandler(async (req, res) => {
  const { reference_month, clients_essencial = 0, clients_negocio = 0, clients_expansao = 0, mrr_addons = 0, total_costs = 0, notes } = req.body;
  if (!reference_month) throw new AppError('reference_month é obrigatório (YYYY-MM-DD)', 400);
  const mrrEssencial = clients_essencial * PLAN_PRICES.essencial;
  const mrrNegocio = clients_negocio * PLAN_PRICES.negocio;
  const mrrExpansao = clients_expansao * PLAN_PRICES.expansao;
  const mrrTotal = mrrEssencial + mrrNegocio + mrrExpansao + parseFloat(mrr_addons);
  const clientsTotal = clients_essencial + clients_negocio + clients_expansao;
  const grossMargin = mrrTotal - parseFloat(total_costs);
  const { rows } = await pool.query(
    `INSERT INTO aura_revenue_snapshot (reference_month,clients_essencial,clients_negocio,clients_expansao,clients_total,mrr_essencial,mrr_negocio,mrr_expansao,mrr_total,mrr_addons,total_costs,gross_margin,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (reference_month) DO UPDATE SET clients_essencial=EXCLUDED.clients_essencial,clients_negocio=EXCLUDED.clients_negocio,clients_expansao=EXCLUDED.clients_expansao,clients_total=EXCLUDED.clients_total,mrr_essencial=EXCLUDED.mrr_essencial,mrr_negocio=EXCLUDED.mrr_negocio,mrr_expansao=EXCLUDED.mrr_expansao,mrr_total=EXCLUDED.mrr_total,mrr_addons=EXCLUDED.mrr_addons,total_costs=EXCLUDED.total_costs,gross_margin=EXCLUDED.gross_margin,notes=EXCLUDED.notes,updated_at=NOW()
     RETURNING *`,
    [reference_month, clients_essencial, clients_negocio, clients_expansao, clientsTotal, mrrEssencial, mrrNegocio, mrrExpansao, mrrTotal, mrr_addons, total_costs, grossMargin, notes || null]
  );
  res.status(201).json({ snapshot: rows[0] });
}));

router.post('/costs', ...adminOnly, asyncHandler(async (req, res) => {
  const { description, amount, category = 'infra', recurrent = true, reference_month, notes } = req.body;
  if (!description || !amount || !reference_month) throw new AppError('description, amount e reference_month são obrigatórios', 400);
  if (parseFloat(amount) <= 0) throw new AppError('amount deve ser maior que zero', 400);
  const validCategories = ['infra', 'tools', 'people', 'marketing', 'other'];
  if (!validCategories.includes(category)) throw new AppError(`category inválido. Use: ${validCategories.join(', ')}`, 400);
  const { rows } = await pool.query(
    `INSERT INTO aura_operational_costs (description,amount,category,recurrent,reference_month,notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [description, amount, category, recurrent, reference_month, notes || null]
  );
  res.status(201).json({ cost: rows[0] });
}));

router.get('/costs', ...adminOnly, asyncHandler(async (req, res) => {
  const { month } = req.query;
  const params = []; let where = '';
  if (month) { params.push(month); where = 'WHERE reference_month = $1'; }
  const { rows } = await pool.query(`SELECT *, SUM(amount) OVER () AS month_total FROM aura_operational_costs ${where} ORDER BY reference_month DESC, created_at DESC`, params);
  res.json({ total: rows[0]?.month_total ? parseFloat(rows[0].month_total) : 0, costs: rows });
}));

// ── BE-18: Equipe ───────────────────────────────────────────

router.get('/team', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT t.id,t.profile,t.permissions,t.is_active,t.notes,t.created_at,u.email,u.full_name AS name FROM aura_team_members t JOIN users u ON u.id=t.user_id ORDER BY t.profile, u.full_name`);
  res.json({ total: rows.length, team: rows });
}));

router.post('/team', ...adminOnly, asyncHandler(async (req, res) => {
  const { user_id, profile, permissions = {}, notes } = req.body;
  if (!user_id || !profile) throw new AppError('user_id e profile são obrigatórios', 400);
  const normalizedProfile = normalizeProfile(profile);
  if (!normalizedProfile) throw new AppError('profile inválido. Use: admin, analyst, support, finance', 400);
  try {
    const { rows } = await pool.query(`INSERT INTO aura_team_members (user_id, profile, permissions, notes) VALUES ($1,$2,$3,$4) RETURNING *`, [user_id, normalizedProfile, JSON.stringify(permissions), notes || null]);
    res.status(201).json({ member: rows[0] });
  } catch (err) { if (err.code === '23505') throw new AppError('Este usuário já é membro da equipe', 409); throw err; }
}));

router.patch('/team/:mid', ...adminOnly, asyncHandler(async (req, res) => {
  const { mid } = req.params;
  const { profile, permissions, is_active, notes } = req.body;
  const fields = [], values = []; let idx = 1;
  if (profile !== undefined) { const n = normalizeProfile(profile); if (!n) throw new AppError('profile inválido', 400); fields.push(`profile=$${idx++}`); values.push(n); }
  if (permissions !== undefined) { fields.push(`permissions=$${idx++}`); values.push(JSON.stringify(permissions)); }
  if (is_active !== undefined) { fields.push(`is_active=$${idx++}`); values.push(is_active); }
  if (notes !== undefined) { fields.push(`notes=$${idx++}`); values.push(notes); }
  if (!fields.length) throw new AppError('Nenhum campo para atualizar', 400);
  fields.push('updated_at=NOW()'); values.push(mid);
  const { rows } = await pool.query(`UPDATE aura_team_members SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`, values);
  if (!rows.length) throw new AppError('Membro não encontrado', 404);
  res.json({ member: rows[0] });
}));

router.delete('/team/:mid', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM aura_team_members WHERE id=$1 RETURNING id', [req.params.mid]);
  if (!rows.length) throw new AppError('Membro não encontrado', 404);
  res.json({ message: 'Membro removido' });
}));

// ── FEAT-01: Simulador de Prospect por CNPJ ───────────────────

router.get('/prospect/:cnpj', ...analystAccess, asyncHandler(async (req, res) => {
  try {
    const analysis = await analyzeCNPJ(req.params.cnpj);
    res.json(analysis);
  } catch (err) {
    const status = err.message.includes('inválido') ? 400 : err.message.includes('não encontrado') ? 404 : err.message.includes('Limite') ? 429 : 500;
    throw new AppError(status === 500 ? 'Erro ao analisar CNPJ' : err.message, status);
  }
}));

// ── FEAT-02: Module overrides per client ─────────────────────

// GET /admin/clients/:cid/modules — view module map for a client
router.get('/clients/:cid/modules', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT plan, module_overrides, trade_name, legal_name FROM companies WHERE id=$1`, [req.params.cid]
  );
  if (!rows.length) throw new AppError('Empresa não encontrada', 404);
  const company = rows[0];
  const overrides = company.module_overrides || {};
  const moduleMap = getModuleMap(company.plan || 'essencial', overrides);
  const visibleModules = getVisibleModules(company.plan || 'essencial', overrides);

  res.json({
    company_id: req.params.cid,
    company_name: company.trade_name || company.legal_name,
    plan: company.plan || 'essencial',
    overrides,
    modules: moduleMap,
    visible: visibleModules,
    available_modules: Object.keys(MODULE_PLAN_MAP),
  });
}));

// PUT /admin/clients/:cid/modules — update module overrides
router.put('/clients/:cid/modules', ...adminOnly, asyncHandler(async (req, res) => {
  const { overrides } = req.body;
  if (typeof overrides !== 'object' || overrides === null) {
    throw new AppError('overrides deve ser um objeto { moduleKey: true/false }', 400);
  }

  // Validate keys
  const validKeys = Object.keys(MODULE_PLAN_MAP);
  for (const key of Object.keys(overrides)) {
    if (!validKeys.includes(key)) throw new AppError(`Módulo inválido: ${key}. Válidos: ${validKeys.join(', ')}`, 400);
    if (typeof overrides[key] !== 'boolean') throw new AppError(`Valor de ${key} deve ser true ou false`, 400);
  }

  // Clean null/undefined values — only keep explicit true/false
  const cleanOverrides = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (v === true || v === false) cleanOverrides[k] = v;
  }

  const { rows } = await pool.query(
    `UPDATE companies SET module_overrides=$1, updated_at=NOW() WHERE id=$2 RETURNING id, plan, module_overrides`,
    [JSON.stringify(cleanOverrides), req.params.cid]
  );
  if (!rows.length) throw new AppError('Empresa não encontrada', 404);

  const moduleMap = getModuleMap(rows[0].plan || 'essencial', cleanOverrides);
  res.json({
    company_id: req.params.cid,
    overrides: cleanOverrides,
    modules: moduleMap,
    visible: getVisibleModules(rows[0].plan || 'essencial', cleanOverrides),
  });
}));

// GET /admin/clients — list all clients with plan + overrides
router.get('/clients', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.trade_name, c.legal_name, c.plan, c.is_active, c.module_overrides,
            c.created_at, u.email AS owner_email, u.full_name AS owner_name
     FROM companies c LEFT JOIN users u ON u.id = c.owner_id
     ORDER BY c.created_at DESC`
  );
  res.json({
    total: rows.length,
    clients: rows.map(r => ({
      ...r,
      visible_modules: getVisibleModules(r.plan || 'essencial', r.module_overrides || {}),
    })),
  });
}));

// ── Relatórios: disparo manual ────────────────────────────────

// Middleware de auth admin simples por ADMIN_SECRET (sem session de usuário)
function adminSecretAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'ADMIN_SECRET não configurado' });
    }
    return next();
  }
  const provided = req.headers['x-admin-secret'];
  if (provided !== secret) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  next();
}

// POST /admin/reports/trigger
// Body: { type: 'weekly' | 'monthly', company_id?: string, to_email?: string }
router.post('/reports/trigger', adminSecretAuth, async (req, res) => {
  const { type = 'weekly', company_id, to_email } = req.body;
  if (!['weekly', 'monthly'].includes(type)) {
    return res.status(400).json({ error: 'type deve ser weekly ou monthly' });
  }

  const start = Date.now();
  try {
    const { generateReport, updateDelivery } = require('../services/reportGenerator');
    const { sendWeeklyReport } = require('../services/mailer');
    const db = require('../config/database');

    // Se company_id específico, processar só ele. Senão, buscar todas.
    let companies;
    if (company_id) {
      const { rows } = await db.query(
        `SELECT id, COALESCE(trade_name, legal_name) AS name, email, plan
         FROM companies WHERE id = $1 AND is_active = true AND email IS NOT NULL`,
        [company_id]
      );
      companies = rows;
    } else {
      const { rows } = await db.query(
        `SELECT id, COALESCE(trade_name, legal_name) AS name, email, plan
         FROM companies WHERE is_active = true AND email IS NOT NULL AND email != '' LIMIT 100`
      );
      companies = rows;
    }

    if (companies.length === 0) {
      return res.status(404).json({ error: 'Nenhuma empresa encontrada' });
    }

    const results = [];
    for (const co of companies) {
      try {
        const result = await generateReport(co.id, type);
        if (result.skipped) {
          results.push({ company_id: co.id, name: co.name, status: 'skipped', reason: result.reason });
          continue;
        }
        // Enviar email (to_email sobrescreve destinatário — apenas para testes)
        const companyForSend = to_email ? { ...result.company, email: to_email } : result.company;
        const emailResult = await sendWeeklyReport(companyForSend, result.kpis, result.html);
        // Marcar como enviado
        await updateDelivery(result.deliveryId, 'sent');
        results.push({
          company_id: co.id,
          name: co.name,
          status: 'sent',
          resend_id: emailResult?.id,
        });
        console.log(`[admin/reports/trigger] sent company=${co.id} type=${type} in ${Date.now()-start}ms`);
      } catch (err) {
        console.error(`[admin/reports/trigger] error company=${co.id}:`, err.message);
        results.push({ company_id: co.id, name: co.name, status: 'error', error: err.message });
      }
    }

    res.json({
      type,
      total: companies.length,
      duration_ms: Date.now() - start,
      results,
    });
  } catch (err) {
    console.error('[admin/reports/trigger] fatal:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/reports/preview/:company_id?type=weekly
// Gera o relatório e devolve o HTML direto no browser — sem enviar email.
// Acesso: mesma auth por X-Admin-Secret (via query param ?secret= para facilitar abertura no browser)
router.get('/reports/preview/:company_id', async (req, res) => {
  // Auth: aceitar X-Admin-Secret header OU query param ?secret=
  const secret = process.env.ADMIN_SECRET;
  if (secret) {
    const provided = req.headers['x-admin-secret'] || req.query.secret;
    if (provided !== secret) {
      return res.status(401).send('<h3>401 — Não autorizado. Passe ?secret=SEU_ADMIN_SECRET na URL.</h3>');
    }
  } else if (process.env.NODE_ENV === 'production') {
    return res.status(403).send('<h3>403 — ADMIN_SECRET não configurado.</h3>');
  }

  const { company_id } = req.params;
  const { type = 'weekly' } = req.query;

  if (!['weekly', 'monthly'].includes(type)) {
    return res.status(400).send('<h3>400 — type deve ser weekly ou monthly</h3>');
  }

  try {
    const { generateReport } = require('../services/reportGenerator');
    const db = require('../config/database');

    const result = await generateReport(company_id, type);

    if (result.skipped) {
      return res.status(200).send(`<h3>Relatório pulado: ${result.reason}</h3>`);
    }

    // Limpar o delivery pending criado (preview não conta como envio)
    await db.query(
      `DELETE FROM report_deliveries WHERE id = $1 AND status = 'pending'`,
      [result.deliveryId]
    ).catch(() => {}); // silencioso

    // Devolver HTML diretamente
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(result.html);

  } catch (err) {
    console.error('[admin/reports/preview] error:', err.message);
    res.status(500).send(`<h3>Erro ao gerar preview: ${err.message}</h3><pre>${err.stack}</pre>`);
  }
});

module.exports = router;
