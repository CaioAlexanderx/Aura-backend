// ============================================================
// AURA. — Preco efetivo e promocao em lote: conta pura (p-84, 08/11/2026)
//
// services/precoEfetivo.js (regra unica de "que preco vale agora") e
// services/promocaoEmLote.js (validacao e previa do POST /promotions).
// O teste .banco confere a mesma regra contra o Postgres real.
// ============================================================
'use strict';

const {
  emPromocao, statusDaPromocao, camposDoProduto, camposDaVariante, comColunasPromo, _resetarParaTeste,
} = require('../src/services/precoEfetivo');
const {
  lerPedido, lerPedidoEncerrar, lerData, montarPrevia, montarEncerrar, itemPublico, MAX_ALVOS,
} = require('../src/services/promocaoEmLote');

const AGORA = new Date('2026-11-28T15:00:00Z');
const ONTEM = '2026-11-27T15:00:00Z';
const AMANHA = '2026-11-29T15:00:00Z';
const SEMANA = '2026-12-05T15:00:00Z';
const PASSADO = '2026-11-20T15:00:00Z';
const ATIVA = { promo_price: '79.90', promo_starts_at: ONTEM, promo_ends_at: AMANHA };

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const V1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const V2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const CID = 'cccccccc-0000-4000-8000-000000000000';

describe('emPromocao / camposDoProduto', () => {
  test('sem promocao: promo nulos e preco_efetivo = price', () => {
    expect(camposDoProduto({ price: '99.90' }, AGORA)).toEqual({
      promo_price: null, promo_starts_at: null, promo_ends_at: null, em_promocao: false, preco_efetivo: 99.9,
    });
  });

  test('em promocao: preco_efetivo = promo_price', () => {
    expect(camposDoProduto({ price: '99.90', ...ATIVA }, AGORA)).toMatchObject({
      promo_price: 79.9, em_promocao: true, preco_efetivo: 79.9,
    });
  });

  test('agendada e vencida: preco normal, mas os campos vem', () => {
    const agendada = camposDoProduto({ price: 99.9, promo_price: 79.9, promo_starts_at: AMANHA, promo_ends_at: SEMANA }, AGORA);
    expect(agendada).toMatchObject({ promo_price: 79.9, em_promocao: false, preco_efetivo: 99.9 });
    const vencida = camposDoProduto({ price: 99.9, promo_price: 79.9, promo_starts_at: PASSADO, promo_ends_at: ONTEM }, AGORA);
    expect(vencida).toMatchObject({ em_promocao: false, preco_efetivo: 99.9 });
  });

  test('limites: comeca exatamente agora vale; termina exatamente agora nao', () => {
    expect(emPromocao(100, { promo_price: 80, promo_starts_at: AGORA, promo_ends_at: AMANHA }, AGORA)).toBe(true);
    expect(emPromocao(100, { promo_price: 80, promo_starts_at: ONTEM, promo_ends_at: AGORA }, AGORA)).toBe(false);
  });

  test('"Por" maior ou igual ao "De" nao vale (preco normal baixado depois)', () => {
    expect(camposDoProduto({ price: 70, ...ATIVA }, AGORA)).toMatchObject({ em_promocao: false, preco_efetivo: 70 });
    expect(camposDoProduto({ price: 79.9, ...ATIVA }, AGORA)).toMatchObject({ em_promocao: false, preco_efetivo: 79.9 });
  });

  test('status da promocao gravada', () => {
    expect(statusDaPromocao({ price: 1 }, AGORA)).toBeNull();
    expect(statusDaPromocao(ATIVA, AGORA)).toBe('ativa');
    expect(statusDaPromocao({ promo_price: 1, promo_starts_at: AMANHA, promo_ends_at: SEMANA }, AGORA)).toBe('agendada');
    expect(statusDaPromocao({ promo_price: 1, promo_starts_at: PASSADO, promo_ends_at: ONTEM }, AGORA)).toBe('encerrada');
  });
});

describe('camposDaVariante', () => {
  const produto = { price: '100.00' };
  const produtoEmPromo = { price: '100.00', promo_price: '80.00', promo_starts_at: ONTEM, promo_ends_at: AMANHA };

  test('sem override e sem promocao: preco do produto', () => {
    expect(camposDaVariante({ price_override: null }, produto, AGORA)).toMatchObject({ em_promocao: false, preco_efetivo: 100 });
  });

  test('sem override: herda a promocao do produto', () => {
    expect(camposDaVariante({ price_override: null }, produtoEmPromo, AGORA)).toMatchObject({
      promo_price: 80, em_promocao: true, preco_efetivo: 80,
    });
  });

  test('com override: item proprio, a promocao do produto nao passa', () => {
    expect(camposDaVariante({ price_override: '120.00' }, produtoEmPromo, AGORA)).toMatchObject({
      promo_price: null, em_promocao: false, preco_efetivo: 120,
    });
  });

  test('com override e promocao propria', () => {
    const v = { price_override: '120.00', promo_price: '99.00', promo_starts_at: ONTEM, promo_ends_at: AMANHA };
    expect(camposDaVariante(v, produto, AGORA)).toMatchObject({ promo_price: 99, em_promocao: true, preco_efetivo: 99 });
  });

  test('sem override, promocao propria agendada e a do produto ativa: vale a do produto agora', () => {
    const v = { price_override: null, promo_price: '70.00', promo_starts_at: AMANHA, promo_ends_at: SEMANA };
    expect(camposDaVariante(v, produtoEmPromo, AGORA)).toMatchObject({ em_promocao: true, preco_efetivo: 80 });
  });

  test('sem override, promocao propria agendada e produto sem promocao: mostra a agendada', () => {
    const v = { price_override: null, promo_price: '70.00', promo_starts_at: AMANHA, promo_ends_at: SEMANA };
    expect(camposDaVariante(v, produto, AGORA)).toMatchObject({ promo_price: 70, em_promocao: false, preco_efetivo: 100 });
  });
});

describe('comColunasPromo', () => {
  beforeEach(() => _resetarParaTeste());

  test('42703 de promo_*: cai para sem as colunas e memoriza', async () => {
    const erro = Object.assign(new Error('column p.promo_price does not exist'), { code: '42703' });
    const fn = jest.fn(async (com) => { if (com) throw erro; return 'sem'; });
    expect(await comColunasPromo(fn)).toBe('sem');
    expect(await comColunasPromo(fn)).toBe('sem');
    expect(fn.mock.calls.map((c) => c[0])).toEqual([true, false, false]);
  });

  test('42703 de outra coluna sobe (a escada da ficha cuida)', async () => {
    const erro = Object.assign(new Error('column "card_price" does not exist'), { code: '42703' });
    await expect(comColunasPromo(async () => { throw erro; })).rejects.toBe(erro);
  });
});

describe('lerPedido', () => {
  const base = { targets: [{ product_id: P1 }], modo: 'percent', valor: 20, ends_at: SEMANA };

  test('padrao: dry_run true, comeca agora, terminacao none', () => {
    const { input } = lerPedido(base, AGORA);
    expect(input).toMatchObject({ dryRun: true, modo: 'percent', valor: 20, terminacao: 'none' });
    expect(input.startsAt.getTime()).toBe(AGORA.getTime());
  });

  test('so o dia vale no horario de Brasilia (00:00 e 23:59:59)', () => {
    expect(lerData('2026-11-27', false).toISOString()).toBe('2026-11-27T03:00:00.000Z');
    expect(lerData('2026-11-30', true).toISOString()).toBe('2026-12-01T02:59:59.000Z');
  });

  test('data futura e permitida; fim antes do comeco ou ja passado nao', () => {
    expect(lerPedido({ ...base, starts_at: '2026-12-01', ends_at: '2026-12-24' }, AGORA).input).toBeTruthy();
    expect(lerPedido({ ...base, starts_at: SEMANA, ends_at: AMANHA }, AGORA).code).toBe('INVALID_DATES');
    expect(lerPedido({ ...base, starts_at: PASSADO, ends_at: ONTEM }, AGORA).code).toBe('INVALID_DATES');
  });

  test('ate 2.000 alvos; acima disso TOO_MANY_TARGETS', () => {
    const muitos = Array.from({ length: MAX_ALVOS + 1 }, (_, i) => ({
      product_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    expect(lerPedido({ ...base, targets: muitos }, AGORA).code).toBe('TOO_MANY_TARGETS');
    expect(lerPedido({ ...base, targets: muitos.slice(0, MAX_ALVOS) }, AGORA).input).toBeTruthy();
  });

  test('corpo invalido', () => {
    expect(lerPedido({ ...base, targets: [] }, AGORA).error).toBeTruthy();
    expect(lerPedido({ ...base, targets: [{ product_id: 'x' }] }, AGORA).error).toBeTruthy();
    expect(lerPedido({ ...base, modo: 'markup' }, AGORA).error).toBeTruthy();
    expect(lerPedido({ ...base, valor: 100 }, AGORA).error).toBeTruthy();
    expect(lerPedido({ ...base, terminacao: '95' }, AGORA).error).toBeTruthy();
    expect(lerPedido({ ...base, dry_run: 'false' }, AGORA).error).toBeTruthy();
    expect(lerPedido({ ...base, ends_at: undefined }, AGORA).error).toBeTruthy();
  });

  test('encerrar: dry_run padrao true', () => {
    expect(lerPedidoEncerrar({ targets: [{ product_id: P1 }] }).input.dryRun).toBe(true);
    expect(lerPedidoEncerrar({ targets: [{ product_id: P1 }], dry_run: false }).input.dryRun).toBe(false);
  });
});

describe('montarPrevia', () => {
  const prod = (id, extra = {}) => ({ id, company_id: CID, name: `Produto ${id.slice(0, 2)}`, sku: 'S', price: '100.00', cost_price: '50.00', is_group_shared: false, ...extra });
  const previa = (body, products, variants = [], extra = {}) => {
    const { input } = lerPedido({ modo: 'percent', valor: 20, ends_at: SEMANA, ...body }, AGORA);
    const r = montarPrevia({ products, variants, input, companyId: CID, groupSize: 1, agora: AGORA, ...extra });
    return { ...r, items: r.items.map(itemPublico) };
  };

  test('percentual com terminacao ,90 para cima (47,92 -> 48,90, igual ao Ajustar preco)', () => {
    const r = previa({ targets: [{ product_id: P1 }], terminacao: '90' }, [prod(P1, { price: '59.90', cost_price: null })]);
    expect(r.items[0]).toMatchObject({ preco_de: 59.9, preco_por: 48.9, ja_em_promocao: false, abaixo_do_custo: false });
    expect(r.items[0]._promoCents).toBeUndefined();
  });

  test('fixo e preco', () => {
    expect(previa({ targets: [{ product_id: P1 }], modo: 'fixed', valor: 15 }, [prod(P1)]).items[0].preco_por).toBe(85);
    expect(previa({ targets: [{ product_id: P1 }], modo: 'preco', valor: 69.9 }, [prod(P1)]).items[0].preco_por).toBe(69.9);
  });

  test('abaixo do custo sai sozinho; com aceitar_abaixo_do_custo entra marcado', () => {
    const r = previa({ targets: [{ product_id: P1 }], valor: 60 }, [prod(P1)]);
    expect(r.items).toEqual([]);
    expect(r.fora[0]).toMatchObject({ product_id: P1, motivo: 'abaixo_do_custo', preco_de: 100, preco_por: 40 });
    const r2 = previa({ targets: [{ product_id: P1, aceitar_abaixo_do_custo: true }], valor: 60 }, [prod(P1)]);
    expect(r2.items[0]).toMatchObject({ preco_por: 40, abaixo_do_custo: true });
  });

  test('sem custo entra (margem nula)', () => {
    const r = previa({ targets: [{ product_id: P1 }], valor: 90 }, [prod(P1, { cost_price: null })]);
    expect(r.items[0]).toMatchObject({ preco_por: 10, abaixo_do_custo: false, cost_price: null, margem: { antes: null, depois: null } });
  });

  test('ja em promocao: substitui e mostra a atual', () => {
    const r = previa({ targets: [{ product_id: P1 }] }, [prod(P1, ATIVA)]);
    expect(r.items[0]).toMatchObject({
      ja_em_promocao: true, promo_atual: { preco: 79.9, status: 'ativa' }, preco_por: 80,
    });
    const venc = previa({ targets: [{ product_id: P1 }] }, [prod(P1, { promo_price: 70, promo_starts_at: PASSADO, promo_ends_at: ONTEM })]);
    expect(venc.items[0]).toMatchObject({ ja_em_promocao: false, promo_atual: null });
  });

  test('produto puxa as variantes com preco proprio; preco_por so na linha do alvo', () => {
    const variants = [
      { id: V1, product_id: P1, price_override: '120.00', label: 'G' },
      { id: V2, product_id: P1, price_override: null, label: 'P' },
    ];
    const r = previa({ targets: [{ product_id: P1, preco_por: 70 }] }, [prod(P1)], variants);
    expect(r.items.map((i) => [i.variant_id, i.preco_de, i.preco_por])).toEqual([[null, 100, 70], [V1, 120, 96]]);
  });

  test('alvo variante: so ela; sem override usa o preco do produto', () => {
    const variants = [{ id: V2, product_id: P1, price_override: null, label: 'P' }];
    const r = previa({ targets: [{ product_id: P1, variant_id: V2 }] }, [prod(P1)], variants);
    expect(r.items.map((i) => [i.variant_id, i.preco_de, i.preco_por])).toEqual([[V2, 100, 80]]);
  });

  test('fora: nao encontrado, sem preco, sem desconto', () => {
    const r = previa({ targets: [{ product_id: P2 }, { product_id: P1, variant_id: V1 }, { product_id: P1 }], modo: 'preco', valor: 150 },
      [prod(P1)], []);
    expect(r.fora.map((f) => f.motivo)).toEqual(['nao_encontrado', 'nao_encontrado', 'sem_desconto']);
    const r2 = previa({ targets: [{ product_id: P1 }] }, [prod(P1, { price: '0' })]);
    expect(r2.fora[0].motivo).toBe('sem_preco');
  });

  test('grupo: compartilhado e de outra empresa sinalizados', () => {
    const r = previa({ targets: [{ product_id: P1 }] }, [prod(P1, { is_group_shared: true, company_id: 'outra' })], [], { groupSize: 2 });
    expect(r.items[0]).toMatchObject({ group_shared: true, owner_is_other: true });
  });
});

describe('montarEncerrar', () => {
  test('produto limpa ele e as variantes com promocao; sem promocao vai em fora', () => {
    const { input } = lerPedidoEncerrar({ targets: [{ product_id: P1 }, { product_id: P2 }] });
    const products = [
      { id: P1, name: 'A', price: '100', ...ATIVA },
      { id: P2, name: 'B', price: '100', promo_price: null },
    ];
    const variants = [{ id: V1, product_id: P1, price_override: '120', promo_price: '90', promo_starts_at: AMANHA, promo_ends_at: SEMANA }];
    const r = montarEncerrar({ products, variants, input, agora: AGORA });
    expect(r.items.map((i) => [i.product_id, i.variant_id, i.status])).toEqual([[P1, null, 'ativa'], [P1, V1, 'agendada']]);
    expect(r.fora).toEqual([{ product_id: P2, variant_id: null, nome: 'B', motivo: 'sem_promocao' }]);
  });
});
