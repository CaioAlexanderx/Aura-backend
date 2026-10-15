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
//         card_fee_enabled, os_enabled, otica_enabled, card_price_enabled,
//         allow_sale_without_stock, comanda_enabled, vale_troca_enabled (true)
//   STRING (enum): studio_approval_mode (wa_me | whatsapp_business),
//                  label_design (classico | editorial)
//   NUMBER: service_fee_pct, food_service_fee_pct,
//           card_fee_credit_pct, card_fee_debit_pct
//   NUMBER OU NULL (percentual 0-100): card_price_pct
//   STRING (enum) OU NULL: label_size (99x21 | 30x25 | 58mm | 105x21 | 40x25)
//   LISTA OU NULL: label_custom_specs (medidas proprias de etiqueta, ate 20)
//   OBJETO OU NULL: label_printer_prefs (calibracao por modelo fixo)
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
  // 06/10/2026 — vender sem estoque. Loja que nao controla saldo (ou acabou
  // de importar o cadastro com tudo zerado) vende mesmo assim; o saldo para
  // em zero, nunca fica negativo. Desligado por padrao. Leitura em
  // utils/vendaSemEstoque.js (Caixa e lancamento de venda no Financeiro).
  'allow_sale_without_stock',
  // 09/10/2026 — Comandas do Caixa (migration 368). Liga "Adicionar a
  // comanda" e "Fechar comanda" no Caixa. Desligado por padrao.
  'comanda_enabled',
  // 13/10/2026 — vale-troca por QR no cupom (aura-app#1056). Ligado por
  // padrao: era a unica preferencia do Caixa guardada so no navegador,
  // entao nao valia em outro aparelho da loja.
  'vale_troca_enabled',
];

// 22/09/2026 — Matcon: lista de unidades habilitadas ("Minha loja vende
// em m², m³, sc..."). Array de strings curtas; ver ALLOWED_STRING_ARRAY_KEYS.
const ALLOWED_STRING_ARRAY_KEYS = {
  matcon_units: { maxItems: 20, maxLen: 8 },
};

// String enum: studio_approval_mode pode ser "wa_me" ou "whatsapp_business"
const ALLOWED_STRING_KEYS = {
  studio_approval_mode: ['wa_me', 'whatsapp_business'],
  // 13/10/2026 — desenho da etiqueta (independe do label_size, que e o
  // formato do papel). 'classico' = o de sempre; 'editorial' = o novo
  // desenho. Nao aceita null: sem escolha e 'classico' (ver DEFAULT_SETTINGS).
  label_design: ['classico', 'editorial'],
};

// 24/09/2026 — modelo de etiqueta escolhido pela loja (aura-app
// LABEL_SIZE_PRESETS). null = a loja nunca escolheu: o app cai na escolha
// antiga do navegador (localStorage) e, sem ela, no 99x21 — por isso o
// default NAO pode ser '99x21' (a Eryca, que usa 30x25 so no navegador,
// voltaria pro 99x21 no primeiro GET). Novos modelos entram nesta lista.
// 25/09/2026 — 105x21: etiqueta 33x21mm em 3 colunas com vao, papel de
// 105mm (Divina D'Lux).
// 14/10/2026 — 40x25: etiqueta 40x25mm em 2 colunas, impressora termica de
// cupom 80mm, desenho editorial compacto (Toda Linda).
const ALLOWED_NULLABLE_STRING_KEYS = {
  label_size: ['99x21', '30x25', '58mm', '105x21', '40x25'],
};

// 01/10/2026 — Modelo dos termos da Garantia de produto (texto livre). null/''
// volta ao modelo padrao da Aura (utils/warrantyTerms.js).
const ALLOWED_TEXT_KEYS = { warranty_terms: 6000 };

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

// 15/10/2026 — configuracao de impressao de etiqueta salva na CONTA (pedido
// do Caio: "para nao perder a configuracao"). Antes vivia so no navegador
// (aura-app customLabelStorage.ts e labelPrinterPrefs.ts); agora vale para a
// loja inteira, em todos os computadores. Loja com duas impressoras que
// erram diferente cria duas medidas ("40x25 balcao" e "40x25 estoque").
// Sem migration: pdv_settings e jsonb.
//
// Politica de validacao (a mesma das demais chaves deste arquivo):
//   - forma errada ou numero fora da faixa => 400 com o nome do campo e a
//     faixa, e NADA e gravado (o app ja satura os valores antes de enviar,
//     entao fora da faixa aqui e bug ou chamada manual);
//   - chave desconhecida dentro de uma medida ou de um modelo => descartada;
//   - numeros arredondados a decimos (o app trabalha em decimos de mm);
//   - medida com id repetido => fica a primeira (igual ao app).
// null = a loja nunca salvou na conta: o app usa o que tiver no navegador e
// sobe uma vez (migracao unica). Lista vazia/objeto vazio = salvou "nada".

// Espelha aura-app components/screens/estoque/labels/customLabel.ts
// (MEDIDA_LIMITES e MEDIDA_PADRAO). Campos opcionais caem no padrao.
const LABEL_CUSTOM_MAX_SPECS = 20;
const LABEL_CUSTOM_ID_MAX = 64;
const LABEL_CUSTOM_NOME_MAX = 40;
const LABEL_CUSTOM_FIELDS = {
  larguraMm:     { min: 15, max: 110, obrigatorio: true },
  alturaMm:      { min: 10, max: 80,  obrigatorio: true },
  colunas:       { min: 1,  max: 3,   padrao: 1, integer: true },
  espacoLadoMm:  { min: 0,  max: 10,  padrao: 3 },
  espacoLinhaMm: { min: 0,  max: 10,  padrao: 2 },
  ajusteXMm:     { min: -8, max: 8,   padrao: 0 },
  ajusteYMm:     { min: -8, max: 8,   padrao: 0 },
};

// Espelha aura-app labelPrinterPrefs.ts + buildLabelHtml.ts: so os modelos
// fixos que aceitam calibracao (rolo com vao e 1 linha por pagina, ou
// calibratable). Passo = altura da pagina do modelo +-3 mm, nunca menor que
// a etiqueta (labelRowPitchMm); deslocamento vertical +-10 mm
// (LABEL_OFFSET_Y_RANGE_MM). 99x21 (Finesse, LOCKED) e 58mm ficam de fora.
const LABEL_PRINTER_MODELS = {
  '105x21': { rowPitchMm: { min: 21, max: 26.5 } },
  '30x25':  { rowPitchMm: { min: 25, max: 30 } },
  '40x25':  { rowPitchMm: { min: 25, max: 30.5 } },
};
const LABEL_OFFSET_Y_MAX = 10;

function decimos(n) {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? 0 : r; // sem -0
}

// Numero de verdade (aceita string numerica com virgula, como o app); boolean,
// null e lixo viram NaN.
function numeroDe(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v.trim().replace(',', '.'));
  return NaN;
}

function numeroNaFaixa(campo, raw, { min, max, integer }) {
  const n = numeroDe(raw);
  const v = integer ? n : decimos(n);
  if (!Number.isFinite(n) || v < min || v > max || (integer && !Number.isInteger(n))) {
    throw new AppError(campo + ' deve ser numero entre ' + min + ' e ' + max + (integer ? ' (inteiro)' : ''), 400);
  }
  return v;
}

function validarMedidasDeEtiqueta(raw) {
  if (raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new AppError('label_custom_specs deve ser lista de medidas (ou null)', 400);
  }
  if (raw.length > LABEL_CUSTOM_MAX_SPECS) {
    throw new AppError('label_custom_specs aceita ate ' + LABEL_CUSTOM_MAX_SPECS + ' medidas', 400);
  }
  const vistos = new Set();
  const out = [];
  raw.forEach((m, i) => {
    const onde = 'label_custom_specs[' + i + ']';
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new AppError(onde + ' deve ser objeto', 400);
    }
    const id = typeof m.id === 'string' ? m.id.trim() : '';
    if (!id || id.length > LABEL_CUSTOM_ID_MAX) {
      throw new AppError(onde + '.id deve ser texto de 1 a ' + LABEL_CUSTOM_ID_MAX + ' caracteres', 400);
    }
    const spec = { id };
    for (const campo of Object.keys(LABEL_CUSTOM_FIELDS)) {
      const regra = LABEL_CUSTOM_FIELDS[campo];
      const valor = m[campo];
      if (valor === undefined || valor === null || valor === '') {
        if (regra.obrigatorio) throw new AppError(onde + '.' + campo + ' e obrigatorio', 400);
        spec[campo] = regra.padrao;
        continue;
      }
      spec[campo] = numeroNaFaixa(onde + '.' + campo, valor, regra);
    }
    if (m.nome !== undefined && m.nome !== null) {
      if (typeof m.nome !== 'string' || m.nome.trim().length > LABEL_CUSTOM_NOME_MAX) {
        throw new AppError(onde + '.nome deve ser texto de ate ' + LABEL_CUSTOM_NOME_MAX + ' caracteres', 400);
      }
      const nome = m.nome.trim();
      if (nome) spec.nome = nome;
    }
    if (vistos.has(id)) return; // id repetido: fica a primeira
    vistos.add(id);
    out.push(spec);
  });
  return out;
}

function validarCalibracaoDaImpressora(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('label_printer_prefs deve ser objeto por modelo (ou null)', 400);
  }
  const out = {};
  for (const modelo of Object.keys(raw)) {
    const regras = LABEL_PRINTER_MODELS[modelo];
    if (!regras) continue; // modelo sem calibracao ou desconhecido: descartado
    const p = raw[modelo];
    const onde = 'label_printer_prefs.' + modelo;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new AppError(onde + ' deve ser objeto', 400);
    }
    const pref = {};
    if (p.continuous !== undefined) {
      if (typeof p.continuous !== 'boolean') throw new AppError(onde + '.continuous deve ser boolean', 400);
      pref.continuous = p.continuous;
    }
    if (p.rowPitchMm !== undefined && p.rowPitchMm !== null) {
      pref.rowPitchMm = numeroNaFaixa(onde + '.rowPitchMm', p.rowPitchMm, regras.rowPitchMm);
    }
    if (p.offsetYMm !== undefined && p.offsetYMm !== null) {
      pref.offsetYMm = numeroNaFaixa(onde + '.offsetYMm', p.offsetYMm, { min: -LABEL_OFFSET_Y_MAX, max: LABEL_OFFSET_Y_MAX });
    }
    out[modelo] = pref;
  }
  return out;
}

const LABEL_CONFIG_KEYS = {
  label_custom_specs: validarMedidasDeEtiqueta,
  label_printer_prefs: validarCalibracaoDaImpressora,
};

const DEFAULT_SETTINGS = {
  require_customer:          false,
  require_seller:            false,
  caixa_enabled:             false,
  crediario_enabled:         false,
  // 12/05/2026: modal de troco em venda dinheiro vem ativado por padrao.
  // Operadores batutos podem desligar em Configuracoes > PDV.
  cash_tender_modal_enabled: true,
  // 06/10/2026 — desligado = a trava de "Estoque insuficiente" de sempre.
  allow_sale_without_stock:  false,
  comanda_enabled:           false,
  // 13/10/2026 — ligado = o cupom leva o QR do vale-troca (comportamento
  // que a loja ja tinha antes de a preferencia ter chave propria).
  vale_troca_enabled:        true,
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
  label_design:              'classico',
  // 15/10/2026 — null = a loja nunca salvou na conta (o app segue no
  // navegador e sobe uma vez). Ver validarMedidasDeEtiqueta.
  label_custom_specs:        null,
  label_printer_prefs:       null,
  warranty_terms:            null,
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

  // Texto livre que aceita null (01/10/2026 — warranty_terms)
  for (const key of Object.keys(ALLOWED_TEXT_KEYS)) {
    if (key in settings) {
      const raw = settings[key];
      if (raw === null || raw === undefined || String(raw).trim() === '') { clean[key] = null; continue; }
      if (typeof raw !== 'string' || raw.length > ALLOWED_TEXT_KEYS[key]) {
        throw new AppError(key + ' deve ser texto de ate ' + ALLOWED_TEXT_KEYS[key] + ' caracteres', 400);
      }
      clean[key] = raw.trim();
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

  // Configuracao de impressao de etiqueta (15/10/2026)
  for (const key of Object.keys(LABEL_CONFIG_KEYS)) {
    if (key in settings) clean[key] = LABEL_CONFIG_KEYS[key](settings[key] === undefined ? null : settings[key]);
  }

  return clean;
}

// 03/10/2026 — studio_enabled e consequencia da vertical, nao escolha do
// lojista. O app salva o objeto inteiro que carregou antes: um PUT com copia
// antiga (studio_enabled:false, o default do GET) chegou 2s depois do admin
// ativar a vertical Studio e desligou a chave — a dona caiu em "Modo Studio
// desativado" e, como o app manda toda empresa Studio pra /studio, ficou sem
// acesso a nada. Empresa da vertical Studio sempre le e grava true.
function applyVerticalInvariants(settings, verticalActive) {
  if (verticalActive === 'studio') settings.studio_enabled = true;
  return settings;
}

// GET /companies/:id/pdv-settings
router.get('/pdv-settings', asyncHandler(async (req, res) => {
  const companyId = req.params.id;
  const { rows } = await pool.query(
    'SELECT pdv_settings, vertical_active FROM companies WHERE id = $1',
    [companyId]
  );
  if (!rows.length) throw new AppError('Empresa nao encontrada', 404);
  // Merge defaults com saved: garante que campos novos tenham valor para
  // empresas com pdv_settings antigo, sem precisar migration.
  const saved = rows[0].pdv_settings || {};
  res.json({
    settings: applyVerticalInvariants({ ...DEFAULT_SETTINGS, ...saved }, rows[0].vertical_active),
  });
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
    'SELECT pdv_settings, vertical_active FROM companies WHERE id = $1',
    [companyId]
  );
  if (!rows.length) throw new AppError('Empresa nao encontrada', 404);
  const saved = rows[0].pdv_settings || {};
  const clean = applyVerticalInvariants(
    validateSettings({ ...saved, ...(settings || {}) }),
    rows[0].vertical_active
  );

  await pool.query(
    'UPDATE companies SET pdv_settings = $1, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(clean), companyId]
  );
  res.json({ settings: clean });
}));

module.exports = router;
