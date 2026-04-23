// ============================================================
// AURA. — Preferencia de layout da sidebar por usuario
//
// GET /auth/sidebar-layout — retorna { layout: { version, items } | null }
// PUT /auth/sidebar-layout — body: { layout: { version, items } | null }
//
// NULL = usar layout padrao do sistema (cliente cai no NAV hardcoded).
// Sincroniza preferencia entre dispositivos do mesmo usuario.
// ============================================================

const router = require('express').Router();
const pool = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const MAX_ITEMS = 50;
const KEY_RE = /^\/[a-z0-9_\-\/]*$/i;
const SECTION_MAX_LEN = 40;

function validateLayout(layout) {
  if (layout === null || layout === undefined) return null;
  if (typeof layout !== 'object' || Array.isArray(layout)) {
    throw new AppError('layout deve ser objeto ou null', 400);
  }
  if (!Array.isArray(layout.items)) {
    throw new AppError('layout.items deve ser array', 400);
  }
  if (layout.items.length > MAX_ITEMS) {
    throw new AppError('layout.items excede limite de ' + MAX_ITEMS, 400);
  }
  const seenKeys = new Set();
  for (const item of layout.items) {
    if (!item || typeof item !== 'object') throw new AppError('item invalido', 400);
    if (typeof item.key !== 'string' || !KEY_RE.test(item.key)) {
      throw new AppError('item.key invalido: ' + item.key, 400);
    }
    if (seenKeys.has(item.key)) {
      throw new AppError('item.key duplicado: ' + item.key, 400);
    }
    seenKeys.add(item.key);
    if (typeof item.section !== 'string' || !item.section.trim() || item.section.length > SECTION_MAX_LEN) {
      throw new AppError('item.section invalido: ' + item.section, 400);
    }
    if (typeof item.hidden !== 'boolean') {
      throw new AppError('item.hidden deve ser boolean', 400);
    }
  }
  return {
    version: typeof layout.version === 'number' ? layout.version : 1,
    items: layout.items.map((i) => ({
      key: i.key,
      section: i.section.trim(),
      hidden: i.hidden,
    })),
  };
}

// GET /auth/sidebar-layout
router.get('/sidebar-layout', requireAuth, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT sidebar_layout FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!rows.length) throw new AppError('Usuario nao encontrado', 404);
  res.json({ layout: rows[0].sidebar_layout || null });
}));

// PUT /auth/sidebar-layout
router.put('/sidebar-layout', requireAuth, asyncHandler(async (req, res) => {
  const { layout } = req.body || {};
  const clean = validateLayout(layout);

  await pool.query(
    'UPDATE users SET sidebar_layout = $1, updated_at = NOW() WHERE id = $2',
    [clean ? JSON.stringify(clean) : null, req.user.id]
  );

  res.json({ layout: clean });
}));

module.exports = router;
