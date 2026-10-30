// ============================================================
// AURA. — Reajuste de preco em lote: conta pura (p-51)
// Modos, terminacao sempre para cima, sem custo, abaixo do custo, grupo,
// preco no cartao manual/automatico, variantes e validacao do corpo.
// ============================================================
'use strict';

const {
  lerPedido, terminar, precoNovo, montarPrevia, itemPublico,
} = require('../src/services/reajusteDePreco');

const CID = '11111111-1111-4111-8111-111111111111';
const OUTRA = '22222222-2222-4222-8222-222222222222';
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function input(over = {}) {
  return { productIds: [id(1)], mode: 'percent', direction: 'up', value: 10, rounding: 'none', dryRun: true, allowBelowCost: false, ...over };
}

function prod(n, over = {}) {
  return { id: id(n), company_id: CID, name: `Produto ${n}`, sku: null, price: '100.00', cost_price: '50.00', card_price: null, is_group_shared: false, ...over };
}

function previa(products, inp, extra = {}) {
  return montarPrevia({ products, variants: [], input: { ...inp, productIds: products.map((p) => p.id) }, companyId: CID, groupSize: 1, ...extra });
}

describe('terminar (sempre para cima)', () => {
  test.each([
    [5320, '90', 5390],
    [5320, '99', 5399],
    [5320, '00', 5400],
    [5300, '00', 5300],
    [5390, '90', 5390],
    [5395, '90', 5490], // 53,95 -> 54,90
    [5399, '99', 5399],
    [5320, 'none', 5320],
  ])('%i com %s = %i', (c, r, esperado) => {
    expect(terminar(c, r)).toBe(esperado);
  });
});

describe('precoNovo por modo', () => {
  test('percentual para cima e para baixo', () => {
    expect(precoNovo(5990, 2450, input())).toBe(6589); // 59,90 + 10% = 65,89 (sem lixo de float)
    expect(precoNovo(10000, null, input({ direction: 'down', value: 15 }))).toBe(8500);
  });
  test('valor fixo soma e tira', () => {
    expect(precoNovo(4990, null, input({ mode: 'fixed', value: 5 }))).toBe(5490);
    expect(precoNovo(4990, null, input({ mode: 'fixed', direction: 'down', value: 5.5 }))).toBe(4440);
  });
  test('markup = custo x (1 + markup)', () => {
    expect(precoNovo(18990, 9200, input({ mode: 'markup', direction: null, value: 60 }))).toBe(14720);
  });
  test('margem = custo / (1 - margem)', () => {
    expect(precoNovo(18990, 9200, input({ mode: 'margin', direction: null, value: 50 }))).toBe(18400);
    // 24,50 / 0,6 = 40,8333 -> 40,83
    expect(precoNovo(5990, 2450, input({ mode: 'margin', direction: null, value: 40 }))).toBe(4083);
  });
  test('sem custo no markup/margem devolve null', () => {
    expect(precoNovo(9990, null, input({ mode: 'markup', value: 60 }))).toBeNull();
    expect(precoNovo(9990, 0, input({ mode: 'margin', value: 50 }))).toBeNull();
  });
  test('terminacao aplicada depois da conta', () => {
    expect(precoNovo(5990, null, input({ rounding: '90' }))).toBe(6590);
    expect(precoNovo(5990, null, input({ rounding: '00' }))).toBe(6600);
  });
});

describe('montarPrevia', () => {
  test('percentual: muda, calcula variacao e margens', () => {
    const r = previa([prod(1)], input());
    const it = r.items[0];
    expect(it).toMatchObject({ status: 'change', price_before: 100, price_after: 110, change_abs: 10, change_pct: 0.1, margin_before: 0.5, margin_after: 0.5455, below_cost: false });
    expect(r.summary).toMatchObject({ items_changed: 1, products_changed: 1, margin_avg_before: 0.5, margin_avg_after: 0.5455 });
  });

  test('sem custo: de fora no markup e na margem, muda no percentual', () => {
    const semCusto = prod(1, { cost_price: null });
    const zero = prod(2, { cost_price: '0' });
    const mk = previa([semCusto, zero], input({ mode: 'markup', direction: null, value: 60 }));
    expect(mk.items.every((i) => i.status === 'skipped' && i.skip_reason === 'no_cost')).toBe(true);
    expect(mk.summary).toMatchObject({ skipped_no_cost: 2, items_changed: 0, margin_avg_before: null });
    const pct = previa([semCusto], input());
    expect(pct.items[0]).toMatchObject({ status: 'change', price_after: 110, margin_before: null, margin_after: null, cost_price: null });
  });

  test('abaixo do custo e marcado', () => {
    const r = previa([prod(1, { price: '60.00', cost_price: '55.00' })], input({ direction: 'down', value: 20 }));
    expect(r.items[0]).toMatchObject({ price_after: 48, below_cost: true });
    expect(r.summary.below_cost).toBe(1);
  });

  test('preco que zeraria fica de fora (not_positive)', () => {
    const r = previa([prod(1, { price: '8.00' })], input({ mode: 'fixed', direction: 'down', value: 10 }));
    expect(r.items[0]).toMatchObject({ status: 'skipped', skip_reason: 'not_positive', price_after: null });
  });

  test('preco igual ao atual = unchanged', () => {
    const r = previa([prod(1, { price: '53.90' })], input({ mode: 'fixed', value: 0.01, rounding: '90' }));
    // 53,91 sobe para 54,90: muda. Com valor que ja cai na terminacao:
    expect(r.items[0].price_after).toBe(54.9);
    const m = previa([prod(2, { price: '184.00', cost_price: '92.00' })], input({ mode: 'margin', direction: null, value: 50 }));
    expect(m.items[0].status).toBe('unchanged');
    expect(m.summary).toMatchObject({ unchanged: 1, items_changed: 0 });
  });

  test('card_price manual acompanha na proporcao; nulo fica nulo', () => {
    const r = previa([prod(1, { card_price: '105.00' }), prod(2, { card_price: null })], input());
    const [manual, auto] = r.items;
    expect(manual).toMatchObject({ card_price_mode: 'manual', card_price_before: 105, card_price_after: 115.5 });
    expect(auto).toMatchObject({ card_price_mode: 'auto', card_price_before: null, card_price_after: null });
    expect(r.summary.card_price_changed).toBe(1);
  });

  test('grupo: so sinaliza quando o grupo tem mais de uma empresa; dona diferente marcada', () => {
    const ps = [prod(1, { is_group_shared: true }), prod(2, { is_group_shared: true, company_id: OUTRA })];
    const sozinha = previa(ps, input());
    expect(sozinha.items.some((i) => i.group_shared)).toBe(false);
    const grupo = previa(ps, input(), { groupSize: 2 });
    expect(grupo.items.map((i) => i.group_shared)).toEqual([true, true]);
    expect(grupo.items.map((i) => i.owner_is_other)).toEqual([false, true]);
    expect(grupo.summary).toMatchObject({ group_shared: 2, owner_is_other: 1 });
  });

  test('variantes com preco proprio viram itens logo apos o produto', () => {
    const p = prod(1, { name: 'Bolsa' });
    const r = montarPrevia({
      products: [prod(2, { name: 'Anel' }), p],
      variants: [{ id: id(91), product_id: id(1), price_override: '120.00', label: 'Preta' }],
      input: input({ productIds: [id(1), id(2), id(3)] }),
      companyId: CID, groupSize: 1,
    });
    expect(r.items.map((i) => [i.name, i.variant_id])).toEqual([['Anel', null], ['Bolsa', null], ['Bolsa', id(91)]]);
    expect(r.items[2]).toMatchObject({ price_before: 120, price_after: 132, variant_label: 'Preta', card_price_mode: null, cost_price: 50 });
    expect(r.summary).toMatchObject({ products_changed: 2, variants_changed: 1, items_changed: 3, not_found: 1 });
    expect(r.notFoundIds).toEqual([id(3)]);
    expect(r.productsChangedCount).toBe(2);
  });

  test('itemPublico tira os campos internos', () => {
    const r = previa([prod(1)], input());
    expect(Object.keys(itemPublico(r.items[0])).some((k) => k.startsWith('_'))).toBe(false);
  });
});

describe('lerPedido', () => {
  const base = { product_ids: [id(1)], mode: 'percent', direction: 'up', value: 10 };
  test('padroes: dry_run true, rounding none, allow_below_cost false', () => {
    const { input: i } = lerPedido(base);
    expect(i).toMatchObject({ dryRun: true, rounding: 'none', allowBelowCost: false, value: 10, productIds: [id(1)] });
  });
  test('aceita valor com virgula e remove ids repetidos', () => {
    const { input: i } = lerPedido({ ...base, value: '10,5', product_ids: [id(1), id(1)] });
    expect(i.value).toBe(10.5);
    expect(i.productIds).toEqual([id(1)]);
  });
  test('markup ignora direction', () => {
    const { input: i } = lerPedido({ product_ids: [id(1)], mode: 'markup', value: 60 });
    expect(i.direction).toBeNull();
  });
  test.each([
    [{ ...base, product_ids: [] }, 'INVALID_INPUT'],
    [{ ...base, product_ids: ['x'] }, 'INVALID_INPUT'],
    [{ ...base, mode: 'outro' }, 'INVALID_INPUT'],
    [{ ...base, direction: undefined }, 'INVALID_INPUT'],
    [{ ...base, value: 0 }, 'INVALID_INPUT'],
    [{ ...base, direction: 'down', value: 100 }, 'INVALID_INPUT'],
    [{ ...base, mode: 'margin', value: 100 }, 'INVALID_INPUT'],
    [{ ...base, rounding: '95' }, 'INVALID_INPUT'],
    [{ ...base, dry_run: 'false' }, 'INVALID_INPUT'],
    [{ ...base, product_ids: Array.from({ length: 2001 }, (_, n) => id(n + 1)) }, 'TOO_MANY_PRODUCTS'],
  ])('recusa %#', (body, code) => {
    expect(lerPedido(body).code).toBe(code);
  });
  test('2.000 produtos passam', () => {
    expect(lerPedido({ ...base, product_ids: Array.from({ length: 2000 }, (_, n) => id(n + 1)) }).input).toBeTruthy();
  });
});
