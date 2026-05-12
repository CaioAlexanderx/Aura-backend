// ============================================================
// AURA. — Configuracoes do PDV/Caixa por empresa
//
// GET /companies/:id/pdv-settings
// PUT /companies/:id/pdv-settings
//
// Persistido em companies.pdv_settings (jsonb).
// Estrutura suportada (extensivel):
//   {
//     require_customer:          bool,
//     require_seller:            bool,
//     caixa_enabled:             bool,   ← toggle para o módulo de caixa
//     cash_tender_modal_enabled: bool    ← 12/05/2026: modal de troco em dinheiro
//   }
// ============================================================

const router = require('express').Router({ mergeParams: true });
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const ALLOWED_KEYS = ['require_customer', 'require_seller', 'caixa_enabled', 'cash_tender_modal_enabled'];
const DEFAULT_SETTINGS = {
  require_customer:          false,
  require_seller:            false,
  caixa_enabled:             false,
  // 12/05/2026: modal de troco em venda dinheiro vem ativado por padrao.
  // Operadores batutos podem desligar em Configuracoes > PDV.
  cash_tender_modal_enabled: true,
};

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
  // Merge defaults com saved: garante que campos novos (ex: cash_tender_modal_enabled)
  // tenham valor para empresas com pdv_settings antigo, sem precisar migration.
  const saved = rows[0].pdv_settings || {};
  res.json({ settings: { ...DEFAULT_SETTINGS, ...saved } });
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
