// ============================================================
// AURA. — Central de Comando: Operacoes (Sprint 4)
//
// GET  /admin/onboarding/pipeline     — Stages do onboarding
// GET  /admin/consultations            — Listar consultorias
// POST /admin/consultations            — Criar consultoria
// PATCH /admin/consultations/:id       — Atualizar consultoria
// GET  /admin/metrics/sla              — SLA de tickets
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

// — GET /admin/onboarding/pipeline ——————————————————————
router.get('/onboarding/pipeline', ...adminOnly, asyncHandler(async (req, res) => {
  // Stage 1: Signup (tem conta)
  const { rows: allCompanies } = await pool.query(
    `SELECT c.id, c.trade_name, c.legal_name, c.plan, c.billing_status, c.created_at, c.cnpj, c.tax_regime,
       u.email, u.full_name,
       (SELECT COUNT(*) FROM transactions WHERE company_id=c.id) AS tx_count,
       (SELECT COUNT(*) FROM products WHERE company_id=c.id) AS prod_count,
       (SELECT COUNT(*) FROM sales WHERE company_id=c.id) AS sales_count
     FROM companies c LEFT JOIN users u ON u.id=c.owner_id
     WHERE c.is_active=true ORDER BY c.created_at DESC`
  );

  const pipeline = { signup: [], cnpj: [], perfil: [], first_sale: [], active: [] };

  allCompanies.forEach(c => {
    const hasCnpj = !!c.cnpj && c.cnpj.length >= 11;
    const hasRegime = !!c.tax_regime;
    const hasTx = parseInt(c.tx_count) > 0;
    const hasSales = parseInt(c.sales_count) > 0;
    const hasProducts = parseInt(c.prod_count) > 0;
    const daysSince = Math.ceil((new Date() - new Date(c.created_at)) / 86400000);

    const item = {
      id: c.id, name: c.trade_name || c.legal_name || 'Sem nome',
      email: c.email, plan: c.plan, billing: c.billing_status,
      days_since_signup: daysSince, created_at: c.created_at,
    };

    if (hasTx || hasSales) { item.stage = 'active'; pipeline.active.push(item); }
    else if (hasProducts) { item.stage = 'first_sale'; pipeline.first_sale.push(item); }
    else if (hasCnpj && hasRegime) { item.stage = 'perfil'; pipeline.perfil.push(item); }
    else if (hasCnpj) { item.stage = 'cnpj'; pipeline.cnpj.push(item); }
    else { item.stage = 'signup'; pipeline.signup.push(item); }
  });

  res.json({
    total: allCompanies.length,
    stages: [
      { key: 'signup', label: 'Cadastro', count: pipeline.signup.length, clients: pipeline.signup },
      { key: 'cnpj', label: 'CNPJ configurado', count: pipeline.cnpj.length, clients: pipeline.cnpj },
      { key: 'perfil', label: 'Perfil completo', count: pipeline.perfil.length, clients: pipeline.perfil },
      { key: 'first_sale', label: 'Produtos/Estoque', count: pipeline.first_sale.length, clients: pipeline.first_sale },
      { key: 'active', label: 'Ativo (transacoes)', count: pipeline.active.length, clients: pipeline.active },
    ],
  });
}));

// — CRUD /admin/consultations ——————————————————————
router.get('/consultations', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT con.*, c.trade_name, c.legal_name, u.full_name AS consultant_name
     FROM aura_consultations con
     LEFT JOIN companies c ON c.id=con.company_id
     LEFT JOIN users u ON u.id=con.consultant_id
     ORDER BY con.date DESC`
  );
  const totalHours = rows.reduce((s, r) => s + parseFloat(r.duration_hours || 0), 0);
  const totalRevenue = rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
  res.json({ total: rows.length, total_hours: totalHours, total_revenue: totalRevenue, consultations: rows });
}));

router.post('/consultations', ...adminOnly, asyncHandler(async (req, res) => {
  const { company_id, date, duration_hours, category, description, amount, notes } = req.body;
  if (!date || !duration_hours) throw new AppError('date e duration_hours obrigatorios', 400);
  const calcAmount = amount || (parseFloat(duration_hours) * 149);
  const { rows } = await pool.query(
    `INSERT INTO aura_consultations (company_id, consultant_id, date, duration_hours, category, description, amount, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [company_id||null, req.user?.id||null, date, duration_hours, category||'setup', description||null, calcAmount, notes||null]
  );
  res.status(201).json({ consultation: rows[0] });
}));

router.patch('/consultations/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, notes, duration_hours, amount } = req.body;
  const fields = [], values = []; let idx = 1;
  if (status) { fields.push(`status=$${idx++}`); values.push(status); }
  if (notes !== undefined) { fields.push(`notes=$${idx++}`); values.push(notes); }
  if (duration_hours) { fields.push(`duration_hours=$${idx++}`); values.push(duration_hours); }
  if (amount) { fields.push(`amount=$${idx++}`); values.push(amount); }
  if (!fields.length) throw new AppError('Nenhum campo', 400);
  fields.push('updated_at=NOW()'); values.push(id);
  const { rows } = await pool.query(`UPDATE aura_consultations SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, values);
  if (!rows.length) throw new AppError('Consultoria nao encontrada', 404);
  res.json({ consultation: rows[0] });
}));

// — GET /admin/metrics/sla ——————————————————————
router.get('/metrics/sla', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: tickets } = await pool.query(
    `SELECT t.id, t.status, t.created_at, t.updated_at,
       (SELECT MIN(m.created_at) FROM support_messages m WHERE m.ticket_id=t.id AND m.sender_type='admin') AS first_response_at
     FROM support_tickets t ORDER BY t.created_at DESC LIMIT 50`
  ).catch(() => ({ rows: [] }));

  let totalResponseTime = 0, responseCount = 0, totalResolutionTime = 0, resolvedCount = 0;
  const openCount = tickets.filter(t => t.status === 'open').length;
  const inProgressCount = tickets.filter(t => t.status === 'in_progress').length;
  const resolvedTotal = tickets.filter(t => t.status === 'resolved' || t.status === 'closed').length;

  tickets.forEach(t => {
    if (t.first_response_at) {
      const responseMs = new Date(t.first_response_at) - new Date(t.created_at);
      totalResponseTime += responseMs; responseCount++;
    }
    if ((t.status === 'resolved' || t.status === 'closed') && t.updated_at) {
      const resMs = new Date(t.updated_at) - new Date(t.created_at);
      totalResolutionTime += resMs; resolvedCount++;
    }
  });

  const avgResponseHours = responseCount > 0 ? Math.round((totalResponseTime / responseCount) / 3600000 * 10) / 10 : null;
  const avgResolutionHours = resolvedCount > 0 ? Math.round((totalResolutionTime / resolvedCount) / 3600000 * 10) / 10 : null;

  res.json({
    total_tickets: tickets.length,
    open: openCount, in_progress: inProgressCount, resolved: resolvedTotal,
    avg_first_response_hours: avgResponseHours,
    avg_resolution_hours: avgResolutionHours,
    sla_met: avgResponseHours !== null && avgResponseHours <= 4,
  });
}));

module.exports = router;
