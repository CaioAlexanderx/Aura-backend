// ============================================================
// Prazo por faixa de tiragem (04/09/2026)
//
// Cinquenta canecas nao ficam prontas no prazo de uma. A tabela de
// faixas da lojista ganha `lead_days`: os dias uteis que ELA declara
// para produzir aquela quantidade. Sem o campo, a cotacao diz "a loja
// informa" — que e verdade — e nao um numero inventado pelo sistema.
// ============================================================
const { parseTiers, buildLadder, leadDaysForQty } = require('../src/services/studioQtyTiers');

const ESCADA = [
  { min_qty: 1, max_qty: 9, unit_multiplier: 1 },
  { min_qty: 10, max_qty: 49, unit_multiplier: 0.9, lead_days: 5 },
  { min_qty: 50, max_qty: null, unit_multiplier: 0.8, lead_days: '10' },
];

describe('parseTiers guarda o prazo', () => {
  test('inteiro e texto numerico viram dias', () => {
    const t = parseTiers(ESCADA);
    expect(t.find((f) => f.min_qty === 10).lead_days).toBe(5);
    expect(t.find((f) => f.min_qty === 50).lead_days).toBe(10);
  });

  test('faixa sem prazo fica null', () => {
    expect(parseTiers(ESCADA).find((f) => f.min_qty === 1).lead_days).toBeNull();
  });

  test('zero, negativo e lixo sao o mesmo que ausente', () => {
    const t = parseTiers([
      { min_qty: 10, unit_multiplier: 0.9, lead_days: 0 },
      { min_qty: 20, unit_multiplier: 0.9, lead_days: -3 },
      { min_qty: 30, unit_multiplier: 0.9, lead_days: 'dez' },
    ]);
    expect(t.map((f) => f.lead_days)).toEqual([null, null, null]);
  });

  test('meio dia vira dia inteiro — prazo nao se promete em fracao', () => {
    expect(parseTiers([{ min_qty: 10, unit_multiplier: 0.9, lead_days: 4.2 }])[0].lead_days).toBe(5);
  });
});

describe('leadDaysForQty', () => {
  test('a faixa que casa entrega o prazo dela', () => {
    expect(leadDaysForQty(ESCADA, 12)).toBe(5);
    expect(leadDaysForQty(ESCADA, 500)).toBe(10);
  });

  test('sem faixa, ou faixa sem prazo, devolve null', () => {
    expect(leadDaysForQty(ESCADA, 3)).toBeNull();
    expect(leadDaysForQty(null, 12)).toBeNull();
    expect(leadDaysForQty([], 12)).toBeNull();
  });
});

describe('buildLadder leva o prazo para a vitrine', () => {
  test('cada degrau com o seu', () => {
    const l = buildLadder(39.90, ESCADA);
    expect(l.map((f) => [f.min_qty, f.lead_days])).toEqual([[10, 5], [50, 10]]);
  });

  test('e continua sem campo de custo', () => {
    for (const f of buildLadder(39.90, ESCADA)) {
      expect(Object.keys(f).sort()).toEqual(['discount_pct', 'lead_days', 'max_qty', 'min_qty', 'unit_price']);
    }
  });
});
