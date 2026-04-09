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
  estoque:        'essencial',
  configuracoes:  'essencial',

  // Negócio+
  folha:          'negocio',
  agendamento:    'negocio',
  clientes:       'negocio',
  canal:          'negocio',
  whatsapp:       'negocio',

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
