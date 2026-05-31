// ============================================================
// AURA. - CRM Comercial - Cadencias (templates de sequencia)
// Steps schema: [{ day: 0, channel: 'whatsapp'|'email'|'call', template: 'texto', subject?: '...' }]
// ============================================================

const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const adminOnly = [requireAuth, requireRole('admin')];

const VALID_CHANNELS = ['whatsapp', 'email', 'call', 'ligacao', 'visita'];

function validateSteps(steps) {
  if (!Array.isArray(steps)) throw new AppError('steps deve ser array', 400);
  for (const [i, s] of steps.entries()) {
    if (typeof s !== 'object' || s === null)
      throw new AppError(`step #${i}: deve ser objeto`, 400);
    if (typeof s.day !== 'number' || s.day < 0)
      throw new AppError(`step #${i}: day deve ser numero >= 0`, 400);
    if (s.channel && !VALID_CHANNELS.includes(s.channel))
      throw new AppError(`step #${i}: channel invalido. Use: ${VALID_CHANNELS.join(', ')}`, 400);
    if (!s.template || typeof s.template !== 'string' || !s.template.trim())
      throw new AppError(`step #${i}: template obrigatorio`, 400);
  }
  // Garantir ordem por day
  return [...steps].sort((a, b) => a.day - b.day);
}

// ============================================================
// GET /admin/cadences - lista cadencias com contagem de uso
// ============================================================
router.get('/', ...adminOnly, asyncHandler(async (req, res) => {
  const { active } = req.query;
  const conditions = [];
  const params = [];
  let idx = 1;
  if (active === 'true')  { conditions.push(`c.is_active = TRUE`); }
  if (active === 'false') { conditions.push(`c.is_active = FALSE`); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const { rows } = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*)::int FROM sales_leads l WHERE l.cadence_name = c.name) AS leads_in_use
     FROM lead_cadences c
     ${where}
     ORDER BY c.is_active DESC, c.name ASC`,
    params
  );
  res.json({ cadences: rows });
}));

// ============================================================
// GET /admin/cadences/:id
// ============================================================
router.get('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM lead_cadences WHERE id = $1`, [req.params.id]);
  if (!rows.length) throw new AppError('Cadencia nao encontrada', 404);
  res.json({ cadence: rows[0] });
}));

// ============================================================
// POST /admin/cadences - criar
// body: { name, description?, steps: [...], is_active? }
// ============================================================
router.post('/', ...adminOnly, asyncHandler(async (req, res) => {
  const { name, description, steps = [], is_active = true } = req.body;
  if (!name || !name.trim()) throw new AppError('name obrigatorio', 400);
  const validatedSteps = validateSteps(steps);

  // Check unique name
  const { rows: existing } = await pool.query(
    `SELECT id FROM lead_cadences WHERE LOWER(name) = LOWER($1)`,
    [name.trim()]
  );
  if (existing.length) throw new AppError(`Cadencia "${name}" ja existe`, 409);

  const { rows } = await pool.query(
    `INSERT INTO lead_cadences (name, description, steps, is_active)
     VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
    [name.trim(), description || null, JSON.stringify(validatedSteps), is_active]
  );
  res.status(201).json({ cadence: rows[0] });
}));

// ============================================================
// PATCH /admin/cadences/:id - editar
// ============================================================
router.patch('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const fields = []; const values = []; let idx = 1;

  if (req.body.name !== undefined) {
    const newName = String(req.body.name).trim();
    if (!newName) throw new AppError('name nao pode ser vazio', 400);
    // Check duplicate
    const { rows: dup } = await pool.query(
      `SELECT id FROM lead_cadences WHERE LOWER(name) = LOWER($1) AND id != $2`,
      [newName, req.params.id]
    );
    if (dup.length) throw new AppError(`Cadencia "${newName}" ja existe`, 409);
    fields.push(`name=$${idx++}`); values.push(newName);
  }
  if (req.body.description !== undefined) {
    fields.push(`description=$${idx++}`); values.push(req.body.description || null);
  }
  if (req.body.steps !== undefined) {
    const validated = validateSteps(req.body.steps);
    fields.push(`steps=$${idx++}::jsonb`); values.push(JSON.stringify(validated));
  }
  if (req.body.is_active !== undefined) {
    fields.push(`is_active=$${idx++}`); values.push(!!req.body.is_active);
  }
  if (!fields.length) throw new AppError('Nenhum campo para atualizar', 400);

  fields.push(`updated_at=NOW()`);
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE lead_cadences SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`,
    values
  );
  if (!rows.length) throw new AppError('Cadencia nao encontrada', 404);
  res.json({ cadence: rows[0] });
}));

// ============================================================
// DELETE /admin/cadences/:id
// Soft delete (is_active=false) se houver leads usando; hard delete se nao.
// ============================================================
router.delete('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: cad } = await pool.query(`SELECT name FROM lead_cadences WHERE id=$1`, [req.params.id]);
  if (!cad.length) throw new AppError('Cadencia nao encontrada', 404);

  const { rows: usage } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM sales_leads WHERE cadence_name = $1`,
    [cad[0].name]
  );

  if (usage[0].total > 0) {
    // Soft delete: apenas desativa
    await pool.query(`UPDATE lead_cadences SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [req.params.id]);
    return res.json({ message: 'Cadencia desativada (em uso por leads)', soft_deleted: true, leads_in_use: usage[0].total });
  }

  await pool.query(`DELETE FROM lead_cadences WHERE id = $1`, [req.params.id]);
  res.json({ message: 'Cadencia removida', soft_deleted: false });
}));

module.exports = router;
