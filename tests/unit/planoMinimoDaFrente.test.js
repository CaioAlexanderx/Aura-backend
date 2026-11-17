// ============================================================
// services/planoMinimoDaFrente (p-195, 17/11/2026)
//
// Personalizados e do Negocio para cima (D4). A regra vale para a vertical
// Studio (como desde 13/07) e, agora, para quem tem
// pdv_settings.studio_enabled === true fora da vertical (casa no Negocio).
//
// Paridade: para quem NAO tem a frente, a resposta e' identica a da regra
// antiga de routes/billing.js (copiada abaixo como referencia).
// ============================================================
const {
  planosExigidos,
  planoPermitido,
  temPersonalizadosLigado,
} = require('../../src/services/planoMinimoDaFrente');
const { PLANS } = require('../../src/services/billingPricing');

// ── Regra antiga (routes/billing.js ate 17/11), copiada como referencia ──
const OLD_VERTICAL_MIN_PLANS = { studio: ['negocio', 'expansao'] };
function oldPlanAllowedForVertical(vertical, plan) {
  const allowed = OLD_VERTICAL_MIN_PLANS[String(vertical || '').toLowerCase()];
  if (!allowed) return true;
  return allowed.includes(String(plan || '').toLowerCase());
}
function oldStatusAllowedPlans(c) {
  return c.vertical_active && OLD_VERTICAL_MIN_PLANS[c.vertical_active]
    ? OLD_VERTICAL_MIN_PLANS[c.vertical_active]
    : Object.keys(PLANS);
}

const VERTICAIS = [null, undefined, '', 'food', 'odonto', 'barber', 'karate_dojo', 'otica', 'studio'];
// Tudo que NAO e' a frente ligada (studio_enabled !== true).
const PDV_SEM_FRENTE = [
  null,
  undefined,
  {},
  { studio_enabled: false },
  { studio_enabled: null },
  { studio_enabled: 'true' }, // texto nao conta: a regra e' === true, como casaNegocio.js
  { studio_enabled: 1 },
  { outra_chave: true },
];
const PLANOS = ['essencial', 'negocio', 'expansao', 'personalizado', 'ESSENCIAL', '', null];

describe('regra unica', () => {
  test('vertical Studio: so Negocio ou Expansao (como hoje)', () => {
    const c = { vertical_active: 'studio', pdv_settings: { studio_enabled: true } };
    expect(planosExigidos(c)).toEqual(['negocio', 'expansao']);
    expect(planoPermitido(c, 'essencial')).toBe(false);
    expect(planoPermitido(c, 'negocio')).toBe(true);
    expect(planoPermitido(c, 'expansao')).toBe(true);
  });

  test('studio_enabled fora da vertical (casa no Negocio): Essencial barrado', () => {
    const c = { vertical_active: null, pdv_settings: { studio_enabled: true } };
    expect(temPersonalizadosLigado(c)).toBe(true);
    expect(planosExigidos(c)).toEqual(['negocio', 'expansao']);
    expect(planoPermitido(c, 'essencial')).toBe(false);
    expect(planoPermitido(c, 'negocio')).toBe(true);
    expect(planoPermitido(c, 'expansao')).toBe(true);
  });

  test('studio_enabled com outra vertical tambem barra o Essencial', () => {
    const c = { vertical_active: 'food', pdv_settings: { studio_enabled: true } };
    expect(planoPermitido(c, 'essencial')).toBe(false);
    expect(planoPermitido(c, 'negocio')).toBe(true);
  });

  test('loja comum: sem restricao', () => {
    const c = { vertical_active: null, pdv_settings: { studio_enabled: false } };
    expect(planosExigidos(c)).toBeNull();
    expect(planoPermitido(c, 'essencial')).toBe(true);
    expect(planoPermitido(c, 'negocio')).toBe(true);
  });

  test('empresa ausente nao quebra', () => {
    expect(planosExigidos(null)).toBeNull();
    expect(planoPermitido(undefined, 'essencial')).toBe(true);
  });
});

describe('paridade: quem nao tem a frente ligada ve exatamente a regra antiga', () => {
  const casos = [];
  for (const v of VERTICAIS) for (const ps of PDV_SEM_FRENTE) casos.push([v, ps]);

  test.each(casos)('vertical=%p pdv_settings=%p', (vertical, pdv) => {
    const c = { vertical_active: vertical, pdv_settings: pdv };
    for (const plan of PLANOS) {
      expect(planoPermitido(c, plan)).toBe(oldPlanAllowedForVertical(vertical, plan));
    }
    expect(planosExigidos(c) || Object.keys(PLANS)).toEqual(oldStatusAllowedPlans(c));
  });
});
