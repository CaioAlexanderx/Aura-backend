// ============================================================
// AURA. - CRM Comercial - Metas mensais de leads
// Schema: reference_month (date, primeiro dia do mes), target_contacts, target_converted, target_mrr, notes
// ============================================================

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

// Helper: aceita "2026-05" ou {year, month} -> Date(2026-05-01)
function toRefMonth(input) {
  if (input && typeof input === 'object' && input.year && input.month) {
    return `${input.year}-${String(input.month).padStart(2, '0')}-01`;
  }
  if (typeof input === 'string') {
    // "2026-05" ou "2026-05-01"
    const match = input.match(/^(\d{4})-(\d{2})(-\d{2})?$/);
    if (match) return `${match[1]}-${match[2]}-01`;
  }
  throw new AppError('reference_month invalido. Use "YYYY-MM" ou {year,month}', 400);
}

// ============================================================
// GET /admin/lead-goals - lista de metas (com progresso real)
// query: year opcional (default ano corrente)
// ============================================================
router.get('/', ...adminOnly, asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year) || new Date().getFullYear();

  const { rows: goals } = await pool.query(
    `SELECT * FROM lead_goals
     WHERE EXTRACT(YEAR FROM reference_month) = $1
     ORDER BY reference_month ASC`,
    [year]
  );

  // Progresso por mes: contatos (interactions) + converted
  const { rows: progress } = await pool.query(
    `SELECT
       date_trunc('month', li.created_at)::date AS month,
       COUNT(DISTINCT li.lead_id)::int          AS actual_contacts
     FROM lead_interactions li
     WHERE EXTRACT(YEAR FROM li.created_at) = $1
     GROUP BY date_trunc('month', li.created_at)`,
    [year]
  );

  const { rows: converted } = await pool.query(
    `SELECT
       date_trunc('month', updated_at)::date AS month,
       COUNT(*)::int                          AS actual_converted,
       COALESCE(SUM(expected_mrr), 0)::numeric AS actual_mrr
     FROM sales_leads
     WHERE status = 'converted'
       AND EXTRACT(YEAR FROM updated_at) = $1
     GROUP BY date_trunc('month', updated_at)`,
    [year]
  );

  const contactsMap = Object.fromEntries(progress.map(p => [p.month.toISOString().slice(0,10), p.actual_contacts]));
  const convertedMap = Object.fromEntries(converted.map(c => [c.month.toISOString().slice(0,10), c]));

  const enriched = goals.map(g => {
    const key = new Date(g.reference_month).toISOString().slice(0,10);
    const conv = convertedMap[key];
    return {
      ...g,
      actual_contacts:  contactsMap[key] || 0,
      actual_converted: conv?.actual_converted || 0,
      actual_mrr:       conv?.actual_mrr || 0,
    };
  });

  res.json({ year, goals: enriched });
}));

// ============================================================
// GET /admin/lead-goals/current - meta do mes atual + progresso ao vivo
// ============================================================
router.get('/current', ...adminOnly, asyncHandler(async (req, res) => {
  const now = new Date();
  const refMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

  const { rows: goalRows } = await pool.query(
    `SELECT * FROM lead_goals WHERE reference_month = $1`,
    [refMonth]
  );
  const goal = goalRows[0] || {
    reference_month: refMonth,
    target_contacts: 0,
    target_converted: 0,
    target_mrr: 0,
  };

  const { rows: contactsRows } = await pool.query(
    `SELECT COUNT(DISTINCT lead_id)::int AS actual
     FROM lead_interactions
     WHERE date_trunc('month', created_at) = $1::date`,
    [refMonth]
  );
  const { rows: convRows } = await pool.query(
    `SELECT
       COUNT(*)::int                          AS actual,
       COALESCE(SUM(expected_mrr), 0)::numeric AS actual_mrr
     FROM sales_leads
     WHERE status = 'converted'
       AND date_trunc('month', updated_at) = $1::date`,
    [refMonth]
  );

  // Calculo de ritmo: dia do mes / total de dias do mes
  const today = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthProgress = today / daysInMonth;
  const paceContacts = monthProgress > 0 ? Math.round(contactsRows[0].actual / monthProgress) : 0;
  const paceConverted = monthProgress > 0 ? Math.round(convRows[0].actual / monthProgress) : 0;

  res.json({
    goal,
    actual_contacts:  contactsRows[0].actual,
    actual_converted: convRows[0].actual,
    actual_mrr:       convRows[0].actual_mrr,
    pace_contacts:    paceContacts,    // projecao linear ate fim do mes
    pace_converted:   paceConverted,
    month_progress:   Math.round(monthProgress * 100),
  });
}));

// ============================================================
// GET /admin/lead-goals/:id
// ============================================================
router.get('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM lead_goals WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new AppError('Meta nao encontrada', 404);
  res.json({ goal: rows[0] });
}));

// ============================================================
// POST /admin/lead-goals - upsert (se ja existe pra o mes, atualiza)
// body: { reference_month: "YYYY-MM" | {year, month}, target_contacts, target_converted, target_mrr?, notes? }
// ============================================================
router.post('/', ...adminOnly, asyncHandler(async (req, res) => {
  const refMonth = toRefMonth(req.body.reference_month);
  const targetContacts  = parseInt(req.body.target_contacts) || 0;
  const targetConverted = parseInt(req.body.target_converted) || 0;
  const targetMrr       = parseFloat(req.body.target_mrr) || 0;
  const notes           = req.body.notes || null;

  // Upsert via existing-check (lead_goals nao tem unique constraint em reference_month por padrao)
  const { rows: existing } = await pool.query(
    `SELECT id FROM lead_goals WHERE reference_month = $1`,
    [refMonth]
  );

  let row;
  if (existing.length) {
    const { rows } = await pool.query(
      `UPDATE lead_goals
       SET target_contacts=$1, target_converted=$2, target_mrr=$3, notes=$4, updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [targetContacts, targetConverted, targetMrr, notes, existing[0].id]
    );
    row = rows[0];
  } else {
    const { rows } = await pool.query(
      `INSERT INTO lead_goals (reference_month, target_contacts, target_converted, target_mrr, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [refMonth, targetContacts, targetConverted, targetMrr, notes]
    );
    row = rows[0];
  }

  res.status(existing.length ? 200 : 201).json({ goal: row, created: !existing.length });
}));

// ============================================================
// PATCH /admin/lead-goals/:id
// ============================================================
router.patch('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const fields = []; const values = []; let idx = 1;

  if (req.body.target_contacts !== undefined) {
    fields.push(`target_contacts=$${idx++}`); values.push(parseInt(req.body.target_contacts) || 0);
  }
  if (req.body.target_converted !== undefined) {
    fields.push(`target_converted=$${idx++}`); values.push(parseInt(req.body.target_converted) || 0);
  }
  if (req.body.target_mrr !== undefined) {
    fields.push(`target_mrr=$${idx++}`); values.push(parseFloat(req.body.target_mrr) || 0);
  }
  if (req.body.notes !== undefined) {
    fields.push(`notes=$${idx++}`); values.push(req.body.notes || null);
  }
  if (!fields.length) throw new AppError('Nenhum campo para atualizar', 400);

  fields.push(`updated_at=NOW()`);
  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE lead_goals SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`,
    values
  );
  if (!rows.length) throw new AppError('Meta nao encontrada', 404);
  res.json({ goal: rows[0] });
}));

// ============================================================
// DELETE /admin/lead-goals/:id
// ============================================================
router.delete('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`DELETE FROM lead_goals WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!rows.length) throw new AppError('Meta nao encontrada', 404);
  res.json({ message: 'Meta removida' });
}));

module.exports = router;
