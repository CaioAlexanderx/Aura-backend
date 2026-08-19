// ============================================================
// AURA Studio — S6: desconto progressivo por quantidade
//
// `studio_pricing_rules.qty_tiers` existia desde o configurador de preco
// do lojista e NUNCA chegava na loja. O unico leitor era o simulador de
// custo em studioPricing.js, que calcula preco sugerido a partir de
// custo + mao de obra + margem — outra conta, e que nao pode ser reusada
// aqui justamente por misturar dado que nao vai para o publico.
//
// O que estes testes protegem, alem da matematica:
//   - nada de custo/margem atravessa (buildLadder so devolve preco e %)
//   - faixa mal cadastrada nunca ENCARECE o pedido
//   - o preco do pedido sai do banco, nao do que o cliente mandou
// ============================================================
'use strict';

const {
  parseTiers, matchTier, unitPriceForQty, buildLadder,
} = require('../src/services/studioQtyTiers');

// Escada tipica de caneca: 1-9 cheio, 10-49 -10%, 50+ preco fixo.
const ESCADA = [
  { min_qty: 10, max_qty: 49, unit_multiplier: 0.9 },
  { min_qty: 50, max_qty: null, unit_price: 29.9 },
];

describe('unitPriceForQty', () => {
  test('abaixo da primeira faixa paga o preco de tabela', () => {
    expect(unitPriceForQty(39.9, ESCADA, 1)).toBe(39.9);
    expect(unitPriceForQty(39.9, ESCADA, 9)).toBe(39.9);
  });

  test('dentro da faixa aplica o multiplicador', () => {
    expect(unitPriceForQty(39.9, ESCADA, 10)).toBeCloseTo(35.91, 2);
    expect(unitPriceForQty(39.9, ESCADA, 49)).toBeCloseTo(35.91, 2);
  });

  test('faixa aberta no topo aplica o preco fixo', () => {
    expect(unitPriceForQty(39.9, ESCADA, 50)).toBe(29.9);
    expect(unitPriceForQty(39.9, ESCADA, 5000)).toBe(29.9);
  });

  test('sem faixa nenhuma devolve o preco de tabela', () => {
    expect(unitPriceForQty(39.9, null, 100)).toBe(39.9);
    expect(unitPriceForQty(39.9, [], 100)).toBe(39.9);
  });

  // Erro de cadastro nao pode virar cobranca a maior.
  test('faixa que sai mais cara que a tabela e ignorada', () => {
    expect(unitPriceForQty(39.9, [{ min_qty: 2, unit_multiplier: 1.5 }], 5)).toBe(39.9);
    expect(unitPriceForQty(39.9, [{ min_qty: 2, unit_price: 99 }], 5)).toBe(39.9);
  });

  test('com faixas sobrepostas vence a de maior min_qty — quem compra mais nao paga mais', () => {
    const sobrepostas = [
      { min_qty: 10, max_qty: null, unit_multiplier: 0.9 },
      { min_qty: 50, max_qty: null, unit_multiplier: 0.7 },
    ];
    expect(unitPriceForQty(100, sobrepostas, 60)).toBe(70);
  });

  test('unit_price manda sobre unit_multiplier quando os dois vem', () => {
    expect(unitPriceForQty(100, [{ min_qty: 1, unit_price: 80, unit_multiplier: 0.5 }], 3)).toBe(80);
  });

  // Achado pelo teste do lado do app: Number(null) e 0, que e finito.
  // Sem esta guarda, faixa com preco corrompido entrega o produto de graca.
  test('faixa com preco zero nao zera o pedido', () => {
    expect(unitPriceForQty(39.9, [{ min_qty: 2, unit_price: 0 }], 5)).toBe(39.9);
    expect(unitPriceForQty(39.9, [{ min_qty: 2, unit_price: null, unit_multiplier: 0.8 }], 5))
      .toBeCloseTo(31.92, 2);
    expect(buildLadder(39.9, [{ min_qty: 2, unit_price: 0 }])).toEqual([]);
  });

  test('quantidade invalida cai no preco de tabela', () => {
    expect(unitPriceForQty(39.9, ESCADA, 0)).toBe(39.9);
    expect(unitPriceForQty(39.9, ESCADA, -5)).toBe(39.9);
    expect(unitPriceForQty(39.9, ESCADA, 'abc')).toBe(39.9);
  });
});

describe('parseTiers — faixa mal cadastrada nao derruba a loja', () => {
  test('aceita jsonb ja parseado e string', () => {
    expect(parseTiers(ESCADA)).toHaveLength(2);
    expect(parseTiers(JSON.stringify(ESCADA))).toHaveLength(2);
  });

  test('descarta o que nao da para aplicar', () => {
    expect(parseTiers([
      { min_qty: 0, unit_multiplier: 0.9 },            // min invalido
      { min_qty: 10, max_qty: 5, unit_multiplier: 0.9 }, // faixa invertida
      { min_qty: 10 },                                   // nao muda nada
      { min_qty: 10, unit_multiplier: 0 },               // multiplicador zero
      { min_qty: 10, unit_price: -1 },                   // preco negativo
      { min_qty: 10, unit_price: 0 },                    // faixa gratuita: nao existe
      null, 'lixo', 42,
    ])).toEqual([]);
  });

  test('string invalida e valor nao-array viram lista vazia', () => {
    expect(parseTiers('{nao e json')).toEqual([]);
    expect(parseTiers({ min_qty: 10 })).toEqual([]);
    expect(parseTiers(undefined)).toEqual([]);
  });

  test('ordena por min_qty — o configurador nao garante ordem', () => {
    const fora = [
      { min_qty: 50, unit_multiplier: 0.7 },
      { min_qty: 10, unit_multiplier: 0.9 },
    ];
    expect(parseTiers(fora).map((t) => t.min_qty)).toEqual([10, 50]);
  });
});

describe('matchTier', () => {
  test('casa pela faixa e respeita o teto', () => {
    const tiers = parseTiers(ESCADA);
    expect(matchTier(tiers, 9)).toBeNull();
    expect(matchTier(tiers, 10).min_qty).toBe(10);
    expect(matchTier(tiers, 50).min_qty).toBe(50);
  });
});

describe('buildLadder — o que a pagina exibe', () => {
  test('uma linha por faixa, com preco unitario e desconto', () => {
    expect(buildLadder(39.9, ESCADA)).toEqual([
      { min_qty: 10, max_qty: 49, unit_price: 35.91, discount_pct: 10 },
      { min_qty: 50, max_qty: null, unit_price: 29.9, discount_pct: 25.1 },
    ]);
  });

  // O payload e publico: custo, mao de obra e margem nao podem vazar.
  test('so devolve campos de preco — nenhum campo de custo', () => {
    const linhas = buildLadder(39.9, [
      { min_qty: 10, unit_multiplier: 0.9, labor_cost: 12, setup_fee: 40, default_margin_pct: 60 },
    ]);
    expect(Object.keys(linhas[0]).sort())
      .toEqual(['discount_pct', 'max_qty', 'min_qty', 'unit_price']);
  });

  test('faixa sem desconto nao vira linha na vitrine', () => {
    expect(buildLadder(39.9, [{ min_qty: 10, unit_multiplier: 1 }])).toEqual([]);
    expect(buildLadder(39.9, [{ min_qty: 10, unit_price: 39.9 }])).toEqual([]);
  });

  test('sem faixas ou sem preco base devolve lista vazia', () => {
    expect(buildLadder(39.9, null)).toEqual([]);
    expect(buildLadder(0, ESCADA)).toEqual([]);
  });
});
