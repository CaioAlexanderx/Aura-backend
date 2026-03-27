// ============================================================
// AURA. — Gestão Aura — Rotas Admin (BE-17/18 + FEAT-01)
// ============================================================

const express = require('express');
const router = express.Router();

const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { analyzeCNPJ } = require('../services/cnpjAnalysis');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];
const analystAccess = [requireAuth, requireRole('admin', 'analyst')];

const PLAN_PRICES = {
  essencial: 99,
  negocio: 179,
  expansao: 299,
};

// ── BE-17: Dashboard ───────────────────────────────────────────

router.get('/dashboard', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: planCounts } = await pool.query(
    `SELECT plan, COUNT(*) AS total
     FROM companies
     WHERE is_active = true
     GROUP BY plan`
  );

  const counts = { essencial: 0, negocio: 0, expansao: 0 };
  planCounts.forEach((r) => {
    counts[r.plan] = parseInt(r.total, 10);
  });

  const totalClients = counts.essencial + counts.negocio + counts.expansao;

  const mrrEstimated =
    counts.essencial * PLAN_PRICES.essencial +
    counts.negocio * PLAN_PRICES.negocio +
    counts.expansao * PLAN_PRICES.expansao;

  const { rows: snapshot } = await pool.query(
    `SELECT *
     FROM aura_revenue_snapshot
     ORDER BY reference_month DESC
     LIMIT 1`
  );

  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const { rows: costs } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
     FROM aura_operational_costs
     WHERE reference_month = $1`,
    [firstOfMonth]
  );

  const totalCosts = parseFloat(costs[0]?.total || 0);
  const grossMargin = mrrEstimated - totalCosts;

  res.json({
    reference_date: new Date().toISOString(),
    clients: {
      total: totalClients,
      essencial: counts.essencial,
      negocio: counts.negocio,
      expansao: counts.expansao,
    },
    mrr: {
      estimated: mrrEstimated,
      last_snapshot: snapshot[0]?.mrr_total || null,
    },
    costs: {
      current_month: totalCosts,
    },
    gross_margin: {
      estimated: grossMargin,
      margin_pct: mrrEstimated > 0
        ? Math.round((grossMargin / mrrEstimated) * 100)
        : null,
    },
  });
}));

router.get('/revenue', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT *
     FROM aura_revenue_snapshot
     ORDER BY reference_month DESC
     LIMIT 12`
  );

  res.json({ snapshots: rows });
}));

router.post('/revenue/snapshot', ...adminOnly, asyncHandler(async (req, res) => {
  const {
    reference_month,
    clients_essencial = 0,
    clients_negocio = 0,
    clients_expansao = 0,
    mrr_addons = 0,
    total_costs = 0,
    notes,
  } = req.body;

  if (!reference_month) {
    throw new AppError('reference_month é obrigatório (YYYY-MM-DD)', 400);
  }

  const mrrEssencial = clients_essencial * PLAN_PRICES.essencial;
  const mrrNegocio = clients_negocio * PLAN_PRICES.negocio;
  const mrrExpansao = clients_expansao * PLAN_PRICES.expansao;
  const mrrTotal = mrrEssencial + mrrNegocio + mrrExpansao + parseFloat(mrr_addons);
  const clientsTotal = clients_essencial + clients_negocio + clients_expansao;
  const grossMargin = mrrTotal - parseFloat(total_costs);

  const { rows } = await pool.query(
    `INSERT INTO aura_revenue_snapshot (
       reference_month,
       clients_essencial,
       clients_negocio,
       clients_expansao,
       clients_total,
       mrr_essencial,
       mrr_negocio,
       mrr_expansao,
       mrr_total,
       mrr_addons,
       total_costs,
       gross_margin,
       notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (reference_month) DO UPDATE SET
       clients_essencial = EXCLUDED.clients_essencial,
       clients_negocio   = EXCLUDED.clients_negocio,
       clients_expansao  = EXCLUDED.clients_expansao,
       clients_total     = EXCLUDED.clients_total,
       mrr_essencial     = EXCLUDED.mrr_essencial,
       mrr_negocio       = EXCLUDED.mrr_negocio,
       mrr_expansao      = EXCLUDED.mrr_expansao,
       mrr_total         = EXCLUDED.mrr_total,
       mrr_addons        = EXCLUDED.mrr_addons,
       total_costs       = EXCLUDED.total_costs,
       gross_margin      = EXCLUDED.gross_margin,
       notes             = EXCLUDED.notes,
       updated_at        = NOW()
     RETURNING *`,
    [
      reference_month,
      clients_essencial,
      clients_negocio,
      clients_expansao,
      clientsTotal,
      mrrEssencial,
      mrrNegocio,
      mrrExpansao,
      mrrTotal,
      mrr_addons,
      total_costs,
      grossMargin,
      notes || null,
    ]
  );

  res.status(201).json({ snapshot: rows[0] });
}));

router.post('/costs', ...adminOnly, asyncHandler(async (req, res) => {
  const {
    description,
    amount,
    category = 'infra',
    recurrent = true,
    reference_month,
    notes,
  } = req.body;

  if (!description || !amount || !reference_month) {
    throw new AppError('description, amount e reference_month são obrigatórios', 400);
  }

  if (parseFloat(amount) <= 0) {
    throw new AppError('amount deve ser maior que zero', 400);
  }

  const validCategories = ['infra', 'tools', 'people', 'marketing', 'other'];
  if (!validCategories.includes(category)) {
    throw new AppError(`category inválido. Use: ${validCategories.join(', ')}`, 400);
  }

  const { rows } = await pool.query(
    `INSERT INTO aura_operational_costs (
       description,
       amount,
       category,
       recurrent,
       reference_month,
       notes
     ) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [description, amount, category, recurrent, reference_month, notes || null]
  );

  res.status(201).json({ cost: rows[0] });
}));

router.get('/costs', ...adminOnly, asyncHandler(async (req, res) => {
  const { month } = req.query;

  const params = [];
  let where = '';

  if (month) {
    params.push(month);
    where = 'WHERE reference_month = $1';
  }

  const { rows } = await pool.query(
    `SELECT *,
            SUM(amount) OVER () AS month_total
     FROM aura_operational_costs
     ${where}
     ORDER BY reference_month DESC, created_at DESC`,
    params
  );

  res.json({
    total: rows[0]?.month_total ? parseFloat(rows[0].month_total) : 0,
    costs: rows,
  });
}));

// ── BE-18: Equipe ───────────────────────────────────────────

router.get('/team', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       t.id,
       t.profile,
       t.permissions,
       t.is_active,
       t.notes,
       t.created_at,
       u.email,
       u.name
     FROM aura_team_members t
     JOIN users u ON u.id = t.user_id
     ORDER BY t.profile, u.name`
  );

  res.json({ total: rows.length, team: rows });
}));

router.post('/team', ...adminOnly, asyncHandler(async (req, res) => {
  const { user_id, profile, permissions = {}, notes } = req.body;

  if (!user_id || !profile) {
    throw new AppError('user_id e profile são obrigatórios', 400);
  }

  const validProfiles = ['admin', 'analista', 'suporte', 'financeiro'];
  if (!validProfiles.includes(profile)) {
    throw new AppError(`profile inválido. Use: ${validProfiles.join(', ')}`, 400);
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO aura_team_members (user_id, profile, permissions, notes)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [user_id, profile, JSON.stringify(permissions), notes || null]
    );

    res.status(201).json({ member: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      throw new AppError('Este usuário já é membro da equipe', 409);
    }
    throw err;
  }
}));

router.patch('/team/:mid', ...adminOnly, asyncHandler(async (req, res) => {
  const { mid } = req.params;
  const { profile, permissions, is_active, notes } = req.body;

  const fields = [];
  const values = [];
  let idx = 1;

  if (profile !== undefined) {
    fields.push(`profile=$${idx++}`);
    values.push(profile);
  }

  if (permissions !== undefined) {
    fields.push(`permissions=$${idx++}`);
    values.push(JSON.stringify(permissions));
  }

  if (is_active !== undefined) {
    fields.push(`is_active=$${idx++}`);
    values.push(is_active);
  }

  if (notes !== undefined) {
    fields.push(`notes=$${idx++}`);
    values.push(notes);
  }

  if (!fields.length) {
    throw new AppError('Nenhum campo para atualizar', 400);
  }

  fields.push('updated_at=NOW()');
  values.push(mid);

  const { rows } = await pool.query(
    `UPDATE aura_team_members
     SET ${fields.join(', ')}
     WHERE id=$${idx}
     RETURNING *`,
    values
  );

  if (!rows.length) {
    throw new AppError('Membro não encontrado', 404);
  }

  res.json({ member: rows[0] });
}));

router.delete('/team/:mid', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'DELETE FROM aura_team_members WHERE id=$1 RETURNING id',
    [req.params.mid]
  );

  if (!rows.length) {
    throw new AppError('Membro não encontrado', 404);
  }

  res.json({ message: 'Membro removido' });
}));

// ── FEAT-01: Simulador de Prospect por CNPJ ───────────────────
// Acessível por: admin + analyst (Analista Comercial durante o pitch)

router.get('/prospect/:cnpj', ...analystAccess, asyncHandler(async (req, res) => {
  try {
    const analysis = await analyzeCNPJ(req.params.cnpj);
    res.json(analysis);
  } catch (err) {
    const status = err.message.includes('inválido') ? 400
      : err.message.includes('não encontrado') ? 404
      : err.message.includes('Limite') ? 429
      : 500;

    throw new AppError(
      status === 500 ? 'Erro ao analisar CNPJ' : err.message,
      status
    );
  }
}));

module.exports = router;
