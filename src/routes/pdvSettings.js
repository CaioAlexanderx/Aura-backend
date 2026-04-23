// ============================================================
// AURA. — Configuracoes do PDV/Caixa por empresa
//
// GET /companies/:id/pdv-settings
// PUT /companies/:id/pdv-settings
//
// Persistido em companies.pdv_settings (jsonb).
// Estrutura suportada (extensivel):
//   { require_customer: bool, require_seller: bool }
// ============================================================

const router = require('express').Router({ mergeParams: true });
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const ALLOWED_KEYS = ['require_customer', 'require_seller'];
const DEFAULT_SETTINGS = { require_customer: false, require_seller: false };

function validateSettings(settings) {
  if (settings === null || settings === undefined) return { ...DEFAULT_SETTINGS };
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    throw new AppError('pdv_settings deve ser objeto', 400);
  }
  // Whitelist + tipo. Ignora chaves desconhecidas pra extensibilidade futura.
  const clean = { ...DEFAULT_SETTINGS };
  for (const key of ALLOWED_KEYS) {
    if (key in settings) {
      if (typeof settings[key] !== 'boolean') {
        throw new AppError(key + ' deve ser boolean', 400);
      }
      clean[key] = settings[key];
    }
  }
  return clean;
}

// GET /companies/:id/pdv-settings
router.get('/pdv-settings', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const { rows } = await pool.query(
    'SELECT pdv_settings FROM companies WHERE id = $1',
    [companyId]
  );
  if (!rows.length) throw new AppError('Empresa nao encontrada', 404);
  res.json({ settings: rows[0].pdv_settings || { ...DEFAULT_SETTINGS } });
}));

// PUT /companies/:id/pdv-settings
router.put('/pdv-settings', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const { settings } = req.body || {};
  const clean = validateSettings(settings);

  await pool.query(
    'UPDATE companies SET pdv_settings = $1, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(clean), companyId]
  );
  res.json({ settings: clean });
}));

module.exports = router;
