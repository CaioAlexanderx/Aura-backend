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
//         card_fee_enabled, os_enabled, otica_enabled, card_price_enabled
//   STRING (enum): studio_approval_mode (wa_me | whatsapp_business)
//   NUMBER: service_fee_pct, food_service_fee_pct,
//           card_fee_credit_pct, card_fee_debit_pct
//   NUMBER OU NULL (percentual 0-100): card_price_pct
//   STRING (enum) OU NULL: label_size (99x21 | 30x25 | 58mm)
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
  // 22/09/2026 — preco no cartao: a loja cobra mais no debito/credito.
  // Todos os planos, desligado por padrao. O % padrao fica em
  // card_price_pct; o preco por produto em products.card_price (351).
  'card_price_enabled',
  // 31/08/2026 — Ordem de Servico. Opt-in: nem toda loja emite OS, e pra
  // quem nao emite o modulo inteiro fica invisivel (menu, botao de imprimir
  // na tela pos-venda, rotas). Ver migration 313.
  'os_enabled',
  // 15/09/2026 — Otica (oculos de grau sobre a OS, kind='otica'). Liga
  // sozinha, sem exigir os_enabled. Ver migration 334 e routes/otica.js.
  'otica_enabled',
  // 22/09/2026 — Matcon (materiais de construcao). Semi-vertical sobre o
  // shell de varejo, mesmo opt-in da OS/Otica. Contrato: aura-app/docs/
  // CONTRACT_MATCON.md. Sem migration: pdv_settings e jsonb.
  'matcon_enabled',
  'matcon_round_to_package',
  'matcon_club_enabled',
  'matcon_lots_enabled',
];

// 22/09/2026 — Matcon: lista de unidades habilitadas ("Minha loja vende
// em m², m³, sc..."). Array de strings curtas; ver ALLOWED_STRING_ARRAY_KEYS.
const ALLOWED_STRING_ARRAY_KEYS = {
  matcon_units: { maxItems: 20, maxLen: 8 },
};

// String enum: studio_approval_mode pode ser "wa_me" ou "whatsapp_business"
const ALLOWED_STRING_KEYS = {
  studio_approval_mode: ['wa_me', 'whatsapp_business'],
};

// 24/09/2026 — modelo de etiqueta escolhido pela loja (aura-app
// LABEL_SIZE_PRESETS). null = a loja nunca escolheu: o app cai na escolha
// antiga do navegador (localStorage) e, sem ela, no 99x21 — por isso o
// default NAO pode ser '99x21' (a Eryca, que usa 30x25 so no navegador,
// voltaria pro 99x21 no primeiro GET). Novos modelos entram nesta lista.
const ALLOWED_NULLABLE_STRING_KEYS = {
  label_size: ['99x21', '30x25', '58mm'],
};

const ALLOWED_NUMBER_KEYS = [
  'service_fee_pct',
  // 22/09/2026 — Matcon (docs/CONTRACT_MATCON.md secoes M0, M1, M3)
  'matcon_default_waste_pct',
  'matcon_default_delivery_days',
  'matcon_quote_valid_days',
  'matcon_quote_warn_days',
  'matcon_points_per_100',
  'matcon_points_to_coupon',
  'matcon_coupon_value',
  'food_service_fee_pct',
  // 17/08/2026 — aliquotas SEPARADAS: a adquirente cobra diferente em
  // credito e debito. Percentuais (5 = 5%), teto de 100 abaixo.
  'card_fee_credit_pct',
  'card_fee_debit_pct',
];

// 22/09/2026 — preco no cartao: acrescimo padrao em % (10 = 10%). Aceita
// null ("ainda nao definido"), que e o default: com number, um null salvo
// viraria 0 no proximo PUT (Number(null) === 0) e a loja passaria a ter
// um acrescimo de zero que ela nunca digitou.
const ALLOWED_NULLABLE_PCT_KEYS = ['card_price_pct'];

// Percentuais que nao fazem sentido acima de 100% — sem teto, um dedo
// escorregado (500 em vez de 5) viraria despesa maior que a venda.
const PCT_KEYS = ['card_fee_credit_pct', 'card_fee_debit_pct', 'matcon_default_waste_pct'];

// 26/08/2026 — calibracao de etiqueta por loja (labels.js). O offset compensa
// a margem fisica do driver da impressora, entao pode ser negativo.
const ALLOWED_RANGED_KEYS = {
  label_offset_mm: { min: -8, max: 5 },
  label_cols:      { min: 1,  max: 5, integer: true },
};

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
  // 22/09/2026 — preco no cartao. Desligado = zero impacto no Caixa.
  card_price_enabled:        false,
  card_price_pct:            null,
  os_enabled:                false,
  otica_enabled:             false,
  // 22/09/2026 — Matcon. Defaults espelham aura-app/constants/matcon.ts.
  matcon_enabled:            false,
  matcon_units:              ['m²', 'm³', 'm', 'sc', 'br', 'mlh', 'ton', 'pç'],
  matcon_default_waste_pct:  10,
  matcon_round_to_package:   true,
  matcon_default_delivery_days: 2,
  matcon_quote_valid_days:   7,
  matcon_quote_warn_days:    3,
  matcon_club_enabled:       true,
  matcon_lots_enabled:       false,
  matcon_points_per_100:     10,
  matcon_points_to_coupon:   100,
  matcon_coupon_value:       10,
  // 0 = neutro: o fluxo real de impressao (aura-app/buildLabelHtml) nunca
  // aplicou offset — um default != 0 deslocaria a impressao de toda loja
  // que nunca calibrou. (-2 era o default da pagina orfa labels.js, que
  // mantem o proprio fallback ao ler o jsonb cru.)
  label_offset_mm:           0,
  label_cols:                3,
  label_size:                null,
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

  // String enum que aceita null (24/09/2026 — label_size)
  for (const key of Object.keys(ALLOWED_NULLABLE_STRING_KEYS)) {
    if (key in settings) {
      const raw = settings[key];
      if (raw === null || raw === '') { clean[key] = null; continue; }
      const allowedValues = ALLOWED_NULLABLE_STRING_KEYS[key];
      if (typeof raw !== 'string' || !allowedValues.includes(raw)) {
        throw new AppError(key + ' deve ser um de: ' + allowedValues.join(', '), 400);
      }
      clean[key] = raw;
    }
  }

  // Arrays de strings curtas (22/09/2026 — matcon_units)
  for (const key of Object.keys(ALLOWED_STRING_ARRAY_KEYS)) {
    if (key in settings) {
      const { maxItems, maxLen } = ALLOWED_STRING_ARRAY_KEYS[key];
      const arr = settings[key];
      if (!Array.isArray(arr) || arr.length > maxItems ||
          arr.some(v => typeof v !== 'string' || !v.trim() || v.length > maxLen)) {
        throw new AppError(key + ' deve ser lista de ate ' + maxItems + ' textos curtos', 400);
      }
      clean[key] = arr.map(v => v.trim());
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

  // Percentuais que aceitam null (22/09/2026 — card_price_pct)
  for (const key of ALLOWED_NULLABLE_PCT_KEYS) {
    if (key in settings) {
      const raw = settings[key];
      if (raw === null || raw === '') { clean[key] = null; continue; }
      const num = typeof raw === 'boolean' ? NaN : Number(raw);
      if (!Number.isFinite(num) || num < 0 || num > 100) {
        throw new AppError(key + ' deve ser percentual entre 0 e 100', 400);
      }
      clean[key] = num;
    }
  }

  // Numbers com faixa propria (podem ser negativos)
  for (const key of Object.keys(ALLOWED_RANGED_KEYS)) {
    if (key in settings) {
      const { min, max, integer } = ALLOWED_RANGED_KEYS[key];
      const num = Number(settings[key]);
      if (!Number.isFinite(num) || num < min || num > max || (integer && !Number.isInteger(num))) {
        throw new AppError(key + ' deve ser numero entre ' + min + ' e ' + max, 400);
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
// Merge sobre o salvo, nao replace: a calibracao de etiqueta e gravada por
// labels.js fora desta tela — um save parcial do app nao pode reseta-la.
router.put('/pdv-settings', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const { settings } = req.body || {};
  if (settings !== null && settings !== undefined && (typeof settings !== 'object' || Array.isArray(settings))) {
    throw new AppError('pdv_settings deve ser objeto', 400);
  }

  const { rows } = await pool.query(
    'SELECT pdv_settings FROM companies WHERE id = $1',
    [companyId]
  );
  if (!rows.length) throw new AppError('Empresa nao encontrada', 404);
  const saved = rows[0].pdv_settings || {};
  const clean = validateSettings({ ...saved, ...(settings || {}) });

  await pool.query(
    'UPDATE companies SET pdv_settings = $1, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(clean), companyId]
  );
  res.json({ settings: clean });
}));

module.exports = router;
