// ============================================================
// AURA. — Configuracoes do PDV/Caixa por empresa
//
// GET /companies/:id/pdv-settings
// PUT /companies/:id/pdv-settings
//
// Persistido em companies.pdv_settings (jsonb).
// Estrutura suportada (extensivel, separada por tipo):
//   BOOL: require_customer, require_seller, caixa_enabled, crediario_enabled,
//         cash_tender_modal_enabled, studio_enabled, studio_kds_enabled,
//         studio_gallery_enabled, studio_approval_enabled, food_mode_enabled,
//         food_nfce_manual_enabled, food_comanda_print_enabled,
//         card_fee_enabled
//   STRING (enum): studio_approval_mode (wa_me | whatsapp_business)
//   NUMBER: service_fee_pct, food_service_fee_pct,
//           card_fee_credit_pct, card_fee_debit_pct
//
// 26/05/2026: ampliada whitelist pra desbloquear UI Studio/Food. Antes,
// app/studio/(estudio)/configuracoes.tsx tentava salvar studio_approval_*
// e o backend descartava silenciosamente (toast generico no front).
// ============================================================

const router = require('express').Router({ mergeParams: true });
const pool = require('../config/database');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../errors/AppError');

const ALLOWED_BOOL_KEYS = [
  'require_customer',
  'require_seller',
  'caixa_enabled',
  'crediario_enabled',
  'cash_tender_modal_enabled',
  // 24-26/05/2026 (Aura Studio)
  'studio_enabled',
  'studio_kds_enabled',
  'studio_gallery_enabled',
  'studio_approval_enabled',
  // 18-22/05/2026 (Aura Food)
  'food_mode_enabled',
  'food_nfce_manual_enabled',
  'food_comanda_print_enabled',
  // 17/08/2026 — taxa da maquininha (Negocio + Studio)
  'card_fee_enabled',
];

// String enum: studio_approval_mode pode ser "wa_me" ou "whatsapp_business"
const ALLOWED_STRING_KEYS = {
  studio_approval_mode: ['wa_me', 'whatsapp_business'],
};

const ALLOWED_NUMBER_KEYS = [
  'service_fee_pct',
  'food_service_fee_pct',
  // 17/08/2026 — aliquotas SEPARADAS: a adquirente cobra diferente em
  // credito e debito. Percentuais (5 = 5%), teto de 100 abaixo.
  'card_fee_credit_pct',
  'card_fee_debit_pct',
];

// Percentuais que nao fazem sentido acima de 100% — sem teto, um dedo
// escorregado (500 em vez de 5) viraria despesa maior que a venda.
const PCT_KEYS = ['card_fee_credit_pct', 'card_fee_debit_pct'];

const DEFAULT_SETTINGS = {
  require_customer:          false,
  require_seller:            false,
  caixa_enabled:             false,
  crediario_enabled:         false,
  // 12/05/2026: modal de troco em venda dinheiro vem ativado por padrao.
  // Operadores batutos podem desligar em Configuracoes > PDV.
  cash_tender_modal_enabled: true,
  studio_enabled:            false,
  studio_kds_enabled:        false,
  studio_gallery_enabled:    false,
  studio_approval_enabled:   false,
  studio_approval_mode:      'wa_me',
  food_mode_enabled:         false,
  food_nfce_manual_enabled:  false,
  food_comanda_print_enabled:false,
  card_fee_enabled:          false,
  card_fee_credit_pct:       0,
  card_fee_debit_pct:        0,
};

function validateSettings(settings) {
  if (settings === null || settings === undefined) return { ...DEFAULT_SETTINGS };
  if (typeof settings !== 'object' || Array.isArray(settings)) {
    throw new AppError('pdv_settings deve ser objeto', 400);
  }
  // Whitelist tipada + ignora chaves desconhecidas (extensibilidade).
  const clean = { ...DEFAULT_SETTINGS };

  // Booleans
  for (const key of ALLOWED_BOOL_KEYS) {
    if (key in settings) {
      if (typeof settings[key] !== 'boolean') {
        throw new AppError(key + ' deve ser boolean', 400);
      }
      clean[key] = settings[key];
    }
  }

  // String enums
  for (const key of Object.keys(ALLOWED_STRING_KEYS)) {
    if (key in settings) {
      const allowedValues = ALLOWED_STRING_KEYS[key];
      if (typeof settings[key] !== 'string' || !allowedValues.includes(settings[key])) {
        throw new AppError(key + ' deve ser um de: ' + allowedValues.join(', '), 400);
      }
      clean[key] = settings[key];
    }
  }

  // Numbers (>= 0)
  for (const key of ALLOWED_NUMBER_KEYS) {
    if (key in settings) {
      const num = Number(settings[key]);
      if (!Number.isFinite(num) || num < 0) {
        throw new AppError(key + ' deve ser numero >= 0', 400);
      }
      if (PCT_KEYS.includes(key) && num > 100) {
        throw new AppError(key + ' deve ser percentual entre 0 e 100', 400);
      }
      clean[key] = num;
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
  // Merge defaults com saved: garante que campos novos tenham valor para
  // empresas com pdv_settings antigo, sem precisar migration.
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
