// ============================================================
// AURA. — Plano minimo de quem tem Personalizados (p-195, 17/11/2026)
//
// Decisao D4 do Caio: Personalizados (o antigo Studio) e do plano Negocio
// para cima. Ate aqui o checkout barrava o Essencial so para quem estava na
// vertical (vertical_active = 'studio'). Com a "casa no Negocio" (p-189,
// services/casaNegocio.js) a empresa sai da vertical (vertical_active = NULL)
// e mantem pdv_settings.studio_enabled = true; nesse estado ela poderia
// assinar o Essencial e perder Personalizados (as rotas /studio pedem
// requirePlan negocio/expansao).
//
// Regra unica, para os dois casos: tem a frente quem esta na vertical Studio
// OU tem pdv_settings.studio_enabled === true. Quem tem a frente so assina
// Negocio ou Expansao. Quem nao tem: nenhuma restricao, como sempre.
//
// Usado por routes/billing.js: POST /subscribe (recusa 400, stage
// 'plan_vertical') e GET /status (allowed_plans, para a tela).
// ============================================================
'use strict';

// Verticais que exigem plano minimo. Espelha o gate do app (Negocio+).
// Studio: nao existe Aura Studio no Essencial — a tela nem carrega.
const VERTICAL_MIN_PLANS = {
  studio: ['negocio', 'expansao'],
};

// Planos que a frente Personalizados aceita no checkout (mesma lista da
// vertical Studio).
const PLANOS_DE_PERSONALIZADOS = VERTICAL_MIN_PLANS.studio;

function temPersonalizadosLigado(company) {
  const ps = company && company.pdv_settings;
  return !!ps && typeof ps === 'object' && ps.studio_enabled === true;
}

// Lista de planos que a empresa pode assinar, ou null quando nao ha
// restricao (loja comum, sem a frente).
function planosExigidos(company) {
  const vertical = String((company && company.vertical_active) || '').toLowerCase();
  if (VERTICAL_MIN_PLANS[vertical]) return VERTICAL_MIN_PLANS[vertical];
  if (temPersonalizadosLigado(company)) return PLANOS_DE_PERSONALIZADOS;
  return null;
}

function planoPermitido(company, plan) {
  const allowed = planosExigidos(company);
  if (!allowed) return true;
  return allowed.includes(String(plan || '').toLowerCase());
}

module.exports = {
  VERTICAL_MIN_PLANS,
  PLANOS_DE_PERSONALIZADOS,
  temPersonalizadosLigado,
  planosExigidos,
  planoPermitido,
};
