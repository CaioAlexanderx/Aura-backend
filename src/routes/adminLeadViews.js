// ============================================================
// AURA. - CRM Comercial - Saved Views (lentes salvas)
// Lentes pre-configuradas + custom user views, com count ao vivo.
// Fase 5 (21/05/2026)
// ============================================================

const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError     = require('../errors/AppError');

const { buildLeadFilterConditions } = require('./adminLeads');

const adminOnly = [requireAuth, requireRole('admin')];

// ============================================================
// GET /admin/lead-views - lista todas as views (system + custom)
// com count ao vivo de cada uma.
// ============================================================
router.get('/', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: views } = await pool.query(
    `SELECT v.*, u.full_name AS created_by_name
     FROM sales_lead_views v
     LEFT JOIN users u ON u.id = v.created_by
     ORDER BY v.is_system DESC, v.sort_order ASC, v.created_at ASC`
  );

  // Pra cada view, executa o filtro e pega count
  // (paraleliza com Promise.all; com 5-15 views isso fica em ~50-100ms total)
  const withCounts = await Promise.all(views.map(async (v) => {
    try {
      const { conditions, params } = buildLeadFilterConditions(v.filters || {});
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const { rows: cr } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM sales_leads l ${where}`,
        params
      );
      return { ...v, lead_count: cr[0]?.total ?? 0 };
    } catch (e) {
      // se filtro armazenado tiver formato invalido, nao explode a lista toda
      console.error('[lead-views] count failed for view', v.id, e.message);
      return { ...v, lead_count: null, count_error: true };
    }
  }));

  res.json({ views: withCounts });
}));

// ============================================================
// GET /admin/lead-views/:id - detalhe de uma view
// ============================================================
router.get('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.*, u.full_name AS created_by_name
     FROM sales_lead_views v
     LEFT JOIN users u ON u.id = v.created_by
     WHERE v.id = $1`,
    [req.params.id]
  );
  if (!rows.length) throw new AppError('View nao encontrada', 404);

  // count
  const v = rows[0];
  try {
    const { conditions, params } = buildLeadFilterConditions(v.filters || {});
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows: cr } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM sales_leads l ${where}`,
      params
    );
    v.lead_count = cr[0]?.total ?? 0;
  } catch (e) {
    v.lead_count = null;
    v.count_error = true;
  }

  res.json({ view: v });
}));

// ============================================================
// POST /admin/lead-views - cria nova view custom
// body: { name, description?, filters, icon?, color?, is_pinned?, sort_order? }
// ============================================================
router.post('/', ...adminOnly, asyncHandler(async (req, res) => {
  const { name, description, filters = {}, icon, color, is_pinned = false, sort_order = 100 } = req.body;
  if (!name || !String(name).trim()) throw new AppError('name e obrigatorio', 400);
  if (typeof filters !== 'object' || Array.isArray(filters))
    throw new AppError('filters deve ser objeto JSON', 400);

  const { rows } = await pool.query(
    `INSERT INTO sales_lead_views (name, description, filters, icon, color, is_pinned, sort_order, created_by, is_system)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE) RETURNING *`,
    [
      String(name).trim(),
      description || null,
      filters,
      icon || null,
      color || null,
      Boolean(is_pinned),
      parseInt(sort_order) || 100,
      req.user?.id || null,
    ]
  );
  res.status(201).json({ view: rows[0] });
}));

// ============================================================
// PATCH /admin/lead-views/:id - editar
// Restricoes: system views so permitem alterar is_pinned e sort_order.
// ============================================================
router.patch('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT * FROM sales_lead_views WHERE id = $1`,
    [req.params.id]
  );
  if (!existing.length) throw new AppError('View nao encontrada', 404);
  const current = existing[0];

  const isSystem = current.is_system;
  const EDITABLE_USER   = ['name', 'description', 'filters', 'icon', 'color', 'is_pinned', 'sort_order'];
  const EDITABLE_SYSTEM = ['is_pinned', 'sort_order'];
  const allow = isSystem ? EDITABLE_SYSTEM : EDITABLE_USER;

  const fields = []; const values = []; let idx = 1;
  for (const key of allow) {
    if (req.body[key] !== undefined) {
      if (key === 'filters' && (typeof req.body[key] !== 'object' || Array.isArray(req.body[key])))
        throw new AppError('filters deve ser objeto JSON', 400);
      fields.push(`${key} = $${idx++}`);
      values.push(key === 'filters' ? req.body[key] : req.body[key]);
    }
  }
  if (!fields.length) throw new AppError('Nenhum campo editavel informado', 400);

  values.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE sales_lead_views SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  res.json({ view: rows[0] });
}));

// ============================================================
// DELETE /admin/lead-views/:id - remove (system nao deletavel)
// ============================================================
router.delete('/:id', ...adminOnly, asyncHandler(async (req, res) => {
  const { rows: existing } = await pool.query(
    `SELECT is_system FROM sales_lead_views WHERE id = $1`,
    [req.params.id]
  );
  if (!existing.length) throw new AppError('View nao encontrada', 404);
  if (existing[0].is_system) throw new AppError('Views do sistema nao podem ser removidas', 403);

  await pool.query(`DELETE FROM sales_lead_views WHERE id = $1`, [req.params.id]);
  res.json({ message: 'View removida' });
}));

module.exports = router;
