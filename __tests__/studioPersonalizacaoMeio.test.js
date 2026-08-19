// ============================================================
// AURA Studio — personalizacao no MEIO (faixa central / wrap 360)
//
// O caso de caneca e copo: a arte da a volta e nao e nem frente nem
// verso. O "meio" espelha o verso em tudo — area propria, cobranca
// opcional e `side` nos fields — entao estes testes existem pra travar
// as tres coisas que quebram silenciosamente se os dois lados
// divergirem: (1) campo do meio exigido com o meio desligado, (2) preco
// cobrado sem o cliente ter escolhido, (3) preco NAO cobrado quando ele
// escolheu.
// ============================================================
'use strict';

const storefront = require('../src/routes/studioStorefront');
const validate = storefront.__validateCustomizationValues;
const computeMiddleDelta = storefront.__computeMiddleDelta;

function configMeio({ cobranca = false, obrigatorio = true } = {}) {
  return {
    print_area: { width_cm: 8, height_cm: 8 },
    has_middle: true,
    middle_print_area: { width_cm: 20, height_cm: 9 },
    ...(cobranca ? { middle_charge_enabled: true, middle_price_delta: 7.5 } : {}),
    fields: [
      { id: 'text',        type: 'text',  label: 'Nome',        required: true,        config: {} },
      { id: 'image_middle', type: 'image', label: 'Arte do meio', required: obrigatorio, side: 'middle', config: {} },
    ],
  };
}

describe('meio — campos so sao exigidos quando o lado esta ativo', () => {
  test('meio SEM cobranca esta sempre ativo: arte do meio e exigida', () => {
    const err = validate(configMeio(), { text: 'Joao' });
    expect(err).toMatch(/informe a arte|Arte do meio/i);
  });

  test('meio SEM cobranca: preenchendo a arte do meio, passa', () => {
    expect(validate(configMeio(), { text: 'Joao', image_middle: 'https://cdn/arte.png' })).toBeNull();
  });

  test('meio COM cobranca e nao escolhido pelo cliente: nao exige a arte do meio', () => {
    expect(validate(configMeio({ cobranca: true }), { text: 'Joao' })).toBeNull();
  });

  test('meio COM cobranca e escolhido: volta a exigir a arte do meio', () => {
    const err = validate(configMeio({ cobranca: true }), { text: 'Joao', has_middle_selected: true });
    expect(err).toMatch(/informe a arte|Arte do meio/i);
  });

  test('meio nao interfere na validacao da frente', () => {
    const cfg = configMeio({ cobranca: true, obrigatorio: false });
    expect(validate(cfg, { text: 'Joao' })).toBeNull();
    expect(validate(cfg, {})).toMatch(/Nome/);
  });
});

describe('meio — delta de preco', () => {
  const cfg = configMeio({ cobranca: true });

  test('cobra so quando o cliente marcou o meio', () => {
    expect(computeMiddleDelta(cfg, { has_middle_selected: true })).toBe(7.5);
  });

  test('nao cobra quando o cliente nao marcou', () => {
    expect(computeMiddleDelta(cfg, {})).toBe(0);
    expect(computeMiddleDelta(cfg, { has_middle_selected: false })).toBe(0);
  });

  test('nao cobra quando a loja nao ligou a cobranca', () => {
    expect(computeMiddleDelta(configMeio(), { has_middle_selected: true })).toBe(0);
  });

  test('produto sem meio nunca cobra', () => {
    expect(computeMiddleDelta({ print_area: {} }, { has_middle_selected: true })).toBe(0);
  });

  test('delta invalido no config nao vira cobranca', () => {
    const ruim = { has_middle: true, middle_charge_enabled: true, middle_price_delta: -3 };
    expect(computeMiddleDelta(ruim, { has_middle_selected: true })).toBe(0);
  });
});
