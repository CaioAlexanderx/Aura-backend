// ============================================================
// AURA. — Module visibility logic
// Plan defaults + admin overrides per company
// ============================================================

// All modules and their minimum plan
const MODULE_PLAN_MAP = {
  // Always visible (all plans)
  painel:         'essencial',
  financeiro:     'essencial',
  nfe:            'essencial',
  contabilidade:  'essencial',
  suporte:        'essencial',
  pdv:            'essencial',
  // 14/09/2026 — Ordem de Serviço ganha chave própria (antes o /os do app
  // usava "pdv" emprestado). Mesmo plano mínimo do pdv. Sem gate de rota:
  // serviceOrders.js continua dependendo só de pdv_settings.os_enabled.
  os:             'essencial',
  estoque:        'essencial',
  // 16/09/2026 — Fase 1 fornecedores (migration 342). Chave propria pra
  // permitir override por empresa igual aos demais submodulos
  // (otica.config etc); a rota (src/routes/suppliers.js) nao gateia por
  // plano, so o app usa isto pra esconder/mostrar o item de menu.
  'estoque.fornecedores': 'essencial',
  configuracoes:  'essencial',
  // 15/09/2026 — Ótica (migration 334). A configuração fica no Essencial
  // para o admin poder dar override do módulo inteiro por empresa; o
  // laboratório e as receitas são Negócio. Sem gate de rota: otica.js e
  // serviceOrders.js dependem só de pdv_settings.otica_enabled.
  'otica.config':      'essencial',
  // 22/09/2026 — Matcon (materiais de construcao). Mesmo desenho da Otica:
  // config no Essencial (override do modulo inteiro por empresa), telas no
  // Negocio. Sem gate de rota: as rotas matcon dependem so de
  // pdv_settings.matcon_enabled. Chaves espelham aura-app/hooks/
  // useVisibleModules.ts.
  'matcon.config':     'essencial',

  // Negócio+
  folha:          'negocio',
  agendamento:    'negocio',
  clientes:       'negocio',
  canal:          'negocio',
  whatsapp:       'negocio',
  'otica.laboratorio': 'negocio',
  'otica.receitas':    'negocio',
  'matcon.orcamentos':    'negocio',
  'matcon.entregas':      'negocio',
  'matcon.profissionais': 'negocio',
  'matcon.compras':       'negocio',

  // Expansão only
  agentes:        'expansao',
};

const PLAN_HIERARCHY = { essencial: 0, negocio: 1, expansao: 2 };

function planLevel(plan) {
  return PLAN_HIERARCHY[plan] ?? 0;
}

/**
 * Returns the list of visible module keys for a company.
 * @param {string} plan - 'essencial' | 'negocio' | 'expansao'
 * @param {object} overrides - { moduleKey: true/false } from companies.module_overrides
 * @returns {string[]} visible module keys
 */
function getVisibleModules(plan = 'essencial', overrides = {}) {
  const level = planLevel(plan);
  const visible = [];

  for (const [mod, minPlan] of Object.entries(MODULE_PLAN_MAP)) {
    const minLevel = planLevel(minPlan);
    const override = overrides?.[mod];

    if (override === false) continue;           // Admin force-hid
    if (override === true)  { visible.push(mod); continue; } // Admin force-show
    if (level >= minLevel)  { visible.push(mod); }           // Plan allows
  }

  return visible;
}

/**
 * Returns full module map with visibility + plan info.
 */
function getModuleMap(plan = 'essencial', overrides = {}) {
  const level = planLevel(plan);
  const result = {};

  for (const [mod, minPlan] of Object.entries(MODULE_PLAN_MAP)) {
    const minLevel = planLevel(minPlan);
    const override = overrides?.[mod];
    let visible, reason;

    if (override === false)       { visible = false; reason = 'admin_hidden'; }
    else if (override === true)   { visible = true;  reason = 'admin_override'; }
    else if (level >= minLevel)   { visible = true;  reason = 'plan'; }
    else                          { visible = false; reason = 'plan_required'; }

    result[mod] = { visible, minPlan, reason };
  }

  return result;
}

module.exports = { MODULE_PLAN_MAP, PLAN_HIERARCHY, getVisibleModules, getModuleMap, planLevel };
