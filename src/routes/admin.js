// ============================================================
// AURA. — Gestão Aura — Rotas Admin (BE-17/18)
// Acesso exclusivo: requireRole('admin')
// ============================================================

const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');

const adminOnly = [requireAuth, requireRole('admin')];

const PLAN_PRICES = { essencial: 99, negocio: 179, expansao: 299 };

// GET /admin/dashboard
router.get('/dashboard', ...adminOnly, async (req, res) => {
  try {
    const { rows: planCounts } = await pool.query(
      `SELECT plan, COUNT(*) AS total FROM companies WHERE is_active = true GROUP BY plan`
    );
    const counts = { essencial: 0, negocio: 0, expansao: 0 };
    planCounts.forEach(r => { counts[r.plan] = parseInt(r.total); });
    const totalClients = counts.essencial + counts.negocio + counts.expansao;
    const mrrEstimated =
      counts.essencial * PLAN_PRICES.essencial +
      counts.negocio   * PLAN_PRICES.negocio +
      counts.expansao  * PLAN_PRICES.expansao;
    const { rows: snapshot } = await pool.query(
      `SELECT * FROM aura_revenue_snapshot ORDER BY reference_month DESC LIMIT 1`
    );
    const now = new Date();
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const { rows: costs } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM aura_operational_costs WHERE reference_month = $1`,
      [firstOfMonth]
    );
    const totalCosts = parseFloat(costs[0]?.total || 0);
    const grossMargin = mrrEstimated - totalCosts;
    res.json({
      reference_date: new Date().toISOString(),
      clients: { total: totalClients, essencial: counts.essencial, negocio: counts.negocio, expansao: counts.expansao },
      mrr: {
        estimated: mrrEstimated,
        last_snapshot: snapshot[0]?.mrr_total || null,
        note: 'Fase 1: MRR estimado com base nos planos cadastrados. Fase 2: MRR real via Asaas (pós-CNPJ).',
      },
      costs: { current_month: totalCosts },
      gross_margin: {
        estimated: grossMargin,
        margin_pct: mrrEstimated > 0 ? Math.round((grossMargin / mrrEstimated) * 100) : null,
      },
    });
  } catch (err) {
    console.error('admin dashboard error:', err);
    res.status(500).json({ error: 'Erro ao buscar dashboard' });
  }
});

// GET /admin/revenue
router.get('/revenue', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM aura_revenue_snapshot ORDER BY reference_month DESC LIMIT 12`);
    res.json({ snapshots: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar receita' }); }
});

// POST /admin/revenue/snapshot
router.post('/revenue/snapshot', ...adminOnly, async (req, res) => {
  try {
    const { reference_month, clients_essencial=0, clients_negocio=0, clients_expansao=0, mrr_addons=0, total_costs=0, notes } = req.body;
    if (!reference_month) return res.status(400).json({ error: 'reference_month é obrigatório (YYYY-MM-DD)' });
    const mrr_essencial = clients_essencial * PLAN_PRICES.essencial;
    const mrr_negocio   = clients_negocio   * PLAN_PRICES.negocio;
    const mrr_expansao  = clients_expansao  * PLAN_PRICES.expansao;
    const mrr_total     = mrr_essencial + mrr_negocio + mrr_expansao + parseFloat(mrr_addons);
    const clients_total = clients_essencial + clients_negocio + clients_expansao;
    const gross_margin  = mrr_total - parseFloat(total_costs);
    const { rows } = await pool.query(
      `INSERT INTO aura_revenue_snapshot (
         reference_month, clients_essencial, clients_negocio, clients_expansao, clients_total,
         mrr_essencial, mrr_negocio, mrr_expansao, mrr_total, mrr_addons, total_costs, gross_margin, notes
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (reference_month) DO UPDATE SET
         clients_essencial=EXCLUDED.clients_essencial, clients_negocio=EXCLUDED.clients_negocio,
         clients_expansao=EXCLUDED.clients_expansao, clients_total=EXCLUDED.clients_total,
         mrr_essencial=EXCLUDED.mrr_essencial, mrr_negocio=EXCLUDED.mrr_negocio,
         mrr_expansao=EXCLUDED.mrr_expansao, mrr_total=EXCLUDED.mrr_total,
         mrr_addons=EXCLUDED.mrr_addons, total_costs=EXCLUDED.total_costs,
         gross_margin=EXCLUDED.gross_margin, notes=EXCLUDED.notes, updated_at=NOW()
       RETURNING *`,
      [reference_month,clients_essencial,clients_negocio,clients_expansao,clients_total,
       mrr_essencial,mrr_negocio,mrr_expansao,mrr_total,mrr_addons,total_costs,gross_margin,notes||null]
    );
    res.status(201).json({ snapshot: rows[0] });
  } catch (err) { console.error('revenue snapshot error:', err); res.status(500).json({ error: 'Erro ao salvar snapshot' }); }
});

// POST /admin/costs
router.post('/costs', ...adminOnly, async (req, res) => {
  try {
    const { description, amount, category='infra', recurrent=true, reference_month, notes } = req.body;
    if (!description || !amount || !reference_month) return res.status(400).json({ error: 'description, amount e reference_month são obrigatórios' });
    if (parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount deve ser maior que zero' });
    const validCategories = ['infra','tools','people','marketing','other'];
    if (!validCategories.includes(category)) return res.status(400).json({ error: `category inválido. Use: ${validCategories.join(', ')}` });
    const { rows } = await pool.query(
      `INSERT INTO aura_operational_costs (description, amount, category, recurrent, reference_month, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [description, amount, category, recurrent, reference_month, notes||null]
    );
    res.status(201).json({ cost: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao lançar custo' }); }
});

// GET /admin/costs
router.get('/costs', ...adminOnly, async (req, res) => {
  try {
    const { month } = req.query;
    const params = [];
    let where = '';
    if (month) { params.push(month); where = 'WHERE reference_month = $1'; }
    const { rows } = await pool.query(
      `SELECT *, SUM(amount) OVER () AS month_total FROM aura_operational_costs ${where} ORDER BY reference_month DESC, created_at DESC`,
      params
    );
    const total = rows[0]?.month_total ? parseFloat(rows[0].month_total) : 0;
    res.json({ total, costs: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar custos' }); }
});

// GET /admin/team
router.get('/team', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.profile, t.permissions, t.is_active, t.notes, t.created_at, u.email, u.name
       FROM aura_team_members t JOIN users u ON u.id = t.user_id
       ORDER BY t.profile, u.name`
    );
    res.json({ total: rows.length, team: rows });
  } catch (err) { res.status(500).json({ error: 'Erro ao buscar equipe' }); }
});

// POST /admin/team
router.post('/team', ...adminOnly, async (req, res) => {
  try {
    const { user_id, profile, permissions={}, notes } = req.body;
    if (!user_id || !profile) return res.status(400).json({ error: 'user_id e profile são obrigatórios' });
    const validProfiles = ['admin','analista','suporte','financeiro'];
    if (!validProfiles.includes(profile)) return res.status(400).json({ error: `profile inválido. Use: ${validProfiles.join(', ')}` });
    const { rows } = await pool.query(
      `INSERT INTO aura_team_members (user_id, profile, permissions, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [user_id, profile, JSON.stringify(permissions), notes||null]
    );
    res.status(201).json({ member: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este usuário já é membro da equipe' });
    res.status(500).json({ error: 'Erro ao adicionar membro' });
  }
});

// PATCH /admin/team/:mid
router.patch('/team/:mid', ...adminOnly, async (req, res) => {
  try {
    const { mid } = req.params;
    const { profile, permissions, is_active, notes } = req.body;
    const fields=[], values=[];
    let idx=1;
    if (profile     !== undefined) { fields.push(`profile=$${idx++}`);     values.push(profile); }
    if (permissions !== undefined) { fields.push(`permissions=$${idx++}`); values.push(JSON.stringify(permissions)); }
    if (is_active   !== undefined) { fields.push(`is_active=$${idx++}`);   values.push(is_active); }
    if (notes       !== undefined) { fields.push(`notes=$${idx++}`);       values.push(notes); }
    if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
    fields.push(`updated_at=NOW()`);
    values.push(mid);
    const { rows } = await pool.query(
      `UPDATE aura_team_members SET ${fields.join(', ')} WHERE id=$${idx} RETURNING *`, values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Membro não encontrado' });
    res.json({ member: rows[0] });
  } catch (err) { res.status(500).json({ error: 'Erro ao atualizar membro' }); }
});

// DELETE /admin/team/:mid
router.delete('/team/:mid', ...adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM aura_team_members WHERE id=$1 RETURNING id', [req.params.mid]);
    if (rows.length === 0) return res.status(404).json({ error: 'Membro não encontrado' });
    res.json({ message: 'Membro removido' });
  } catch (err) { res.status(500).json({ error: 'Erro ao remover membro' }); }
});

module.exports = router;
