// ============================================================
// AURA. — Venda condicional (C11): cobrar no Caixa, sem banco
// services/condicionalVenda.js com um client falso: leitura do corpo,
// carrinho x pecas, ordem das travas, 409s, gravar/encerrar e o caminho de
// volta ao cancelar. O Postgres de verdade: condicionalVenda.banco.test.js.
// ============================================================
'use strict';

const v = require('../src/services/condicionalVenda');
const c = require('../src/services/condicional');

const COND = '11111111-2222-3333-4444-555555555555';
const LOJA = '99999999-8888-7777-6666-555555555555';
const I1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const I2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const P1 = 'bbbbbbbb-0000-0000-0000-000000000001';
const P2 = 'bbbbbbbb-0000-0000-0000-000000000002';
const VAR = 'dddddddd-0000-0000-0000-000000000001';
const VENDA = 'cccccccc-0000-0000-0000-000000000001';

function fakeClient(respostas) {
  const chamadas = [];
  return {
    chamadas,
    query: jest.fn(async (sql, params) => {
      chamadas.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      for (const [re, rows] of respostas) if (re.test(sql)) return { rows };
      return { rows: [] };
    }),
  };
}

describe('lerPedido', () => {
  test('sem condicional_id: null (venda comum)', () => {
    expect(v.lerPedido({})).toBeNull();
    expect(v.lerPedido({ condicional_id: null })).toBeNull();
    expect(v.lerPedido({ condicional_id: '' })).toBeNull();
    expect(v.lerPedido(undefined)).toBeNull();
  });
  test('le ids e recusa o que nao presta', () => {
    expect(v.lerPedido({ condicional_id: COND.toUpperCase(), condicional_item_ids: [I1, I2] })).toEqual({ condId: COND, itemIds: [I1, I2] });
    expect(v.lerPedido({ condicional_id: 'x', condicional_item_ids: [I1] }).erro.status).toBe(422);
    expect(v.lerPedido({ condicional_id: COND }).erro.code).toBe('COND_ITENS_OBRIGATORIOS');
    expect(v.lerPedido({ condicional_id: COND, condicional_item_ids: [] }).erro.code).toBe('COND_ITENS_OBRIGATORIOS');
    expect(v.lerPedido({ condicional_id: COND, condicional_item_ids: [I1, I1] }).erro.code).toBe('COND_ITENS_INVALIDOS');
    expect(v.lerPedido({ condicional_id: COND, condicional_item_ids: ['nada'] }).erro.code).toBe('COND_ITENS_INVALIDOS');
  });
});

describe('carrinhoConfere', () => {
  const pecas = [{ product_id: P1, variant_id: null }, { product_id: P2, variant_id: VAR }];
  test('mesmo produto/variante e quantidade', () => {
    expect(v.carrinhoConfere([{ product_id: P2, variant_id: VAR, quantity: 1 }, { product_id: P1, quantity: 1 }], pecas)).toBe(true);
  });
  test('soma linhas repetidas do mesmo produto', () => {
    expect(v.carrinhoConfere([{ product_id: P1, quantity: 2 }], [{ product_id: P1 }, { product_id: P1 }])).toBe(true);
  });
  test('recusa variante, quantidade, produto a mais ou item avulso', () => {
    expect(v.carrinhoConfere([{ product_id: P1, quantity: 1 }, { product_id: P2, quantity: 1 }], pecas)).toBe(false);
    expect(v.carrinhoConfere([{ product_id: P1, quantity: 2 }, { product_id: P2, variant_id: VAR, quantity: 1 }], pecas)).toBe(false);
    expect(v.carrinhoConfere([{ product_id: P1, quantity: 1 }], pecas)).toBe(false);
    expect(v.carrinhoConfere([{ product_id: P1, quantity: 1 }, { quantity: 1 }], [{ product_id: P1 }, { product_id: P2 }])).toBe(false);
  });
});

describe('travar', () => {
  const pedido = { condId: COND, itemIds: [I1] };
  const items = [{ product_id: P1, quantity: 1 }];
  const base = (itens, cond = { id: COND, numero: 31, status: 'aberta' }, venda = []) => fakeClient([
    [/FROM condicionais WHERE/, [cond]],
    [/FROM condicional_itens/, itens],
    [/SELECT sale_number FROM sales/, venda],
  ]);
  const peca = (extra) => ({ id: I1, product_id: P1, variant_id: null, situacao: 'com_cliente', sale_id: null, ...extra });

  test('trava a condicional e depois os itens, nesta ordem, com FOR UPDATE', async () => {
    const client = base([peca()]);
    const r = await v.travar(client, { companyId: LOJA, pedido, items });
    expect(r.escolhidos).toHaveLength(1);
    expect(client.chamadas[0].sql).toMatch(/FROM condicionais .* FOR UPDATE$/);
    expect(client.chamadas[1].sql).toMatch(/FROM condicional_itens .* ORDER BY id FOR UPDATE$/);
  });

  test('peca ja cobrada: 409 com o numero da venda', async () => {
    const client = base([peca({ sale_id: VENDA, situacao: 'ficou' })], undefined, [{ sale_number: 1234 }]);
    await expect(v.travar(client, { companyId: LOJA, pedido, items })).rejects.toMatchObject({
      statusCode: 409, code: 'COND_JA_COBRADA', message: 'Estas peças já foram cobradas na venda #1234.', extra: { venda_numero: 1234 },
    });
  });

  test('peca de outra condicional, situacao errada, fechada e carrinho diferente', async () => {
    await expect(v.travar(base([]), { companyId: LOJA, pedido, items })).rejects.toMatchObject({ statusCode: 409, code: 'COND_ITEM_INVALIDO' });
    await expect(v.travar(base([peca({ situacao: 'voltou' })]), { companyId: LOJA, pedido, items }))
      .rejects.toMatchObject({ statusCode: 409, code: 'COND_ITEM_SITUACAO' });
    await expect(v.travar(base([peca({ situacao: 'voltou_defeito' })]), { companyId: LOJA, pedido, items }))
      .rejects.toMatchObject({ code: 'COND_ITEM_SITUACAO' });
    await expect(v.travar(base([peca()], { id: COND, numero: 31, status: 'encerrada' }), { companyId: LOJA, pedido, items }))
      .rejects.toMatchObject({ statusCode: 409, code: 'COND_FECHADA' });
    await expect(v.travar(base([peca()]), { companyId: LOJA, pedido, items: [{ product_id: P2, quantity: 1 }] }))
      .rejects.toMatchObject({ statusCode: 422, code: 'COND_CARRINHO_DIFERENTE' });
  });

  test('condicional de outra loja: 404', async () => {
    const client = fakeClient([[/FROM condicionais WHERE/, []]]);
    await expect(v.travar(client, { companyId: LOJA, pedido, items })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('gravar', () => {
  const sale = { id: VENDA, sale_number: 77 };
  test('2 de 3 pecas: marca ficou+sale_id, evento venda e NAO encerra', async () => {
    const todos = [
      { id: I1, situacao: 'com_cliente', sale_id: null }, { id: I2, situacao: 'ficou', sale_id: null },
      { id: 'aaaaaaaa-0000-0000-0000-000000000003', situacao: 'com_cliente', sale_id: null },
    ];
    const client = fakeClient([]);
    const r = await v.gravar(client, { companyId: LOJA, userId: 'u', sale: { ...sale }, ctx: { cond: { id: COND, numero: 31 }, todos, escolhidos: todos.slice(0, 2) } });
    expect(r).toEqual({ id: COND, numero: 31, itens: 2, encerrada: false });
    const sqls = client.chamadas.map((x) => x.sql);
    expect(sqls.some((s) => /UPDATE sales SET condicional_id/.test(s))).toBe(true);
    expect(sqls.some((s) => /SET situacao = 'ficou', sale_id = \$1/.test(s))).toBe(true);
    expect(sqls.filter((s) => /'venda'/.test(s))).toHaveLength(2);
    expect(sqls.some((s) => /status = 'encerrada'/.test(s))).toBe(false);
  });
  test('o resto das pecas encerra com o evento encerrada', async () => {
    const todos = [{ id: I1, situacao: 'ficou', sale_id: VENDA }, { id: I2, situacao: 'com_cliente', sale_id: null }];
    const client = fakeClient([]);
    const r = await v.gravar(client, { companyId: LOJA, userId: null, sale: { ...sale }, ctx: { cond: { id: COND, numero: 31 }, todos, escolhidos: [todos[1]] } });
    expect(r.encerrada).toBe(true);
    expect(client.chamadas.some((x) => /status = 'encerrada'/.test(x.sql))).toBe(true);
    expect(client.chamadas.some((x) => /'encerrada'/.test(x.sql) && /INSERT INTO condicional_eventos/.test(x.sql))).toBe(true);
  });
});

describe('voltarAoCancelar', () => {
  test('venda comum: uma consulta e mais nada', async () => {
    const client = fakeClient([]);
    expect(await v.voltarAoCancelar(client, { companyId: LOJA, saleId: VENDA, userId: null })).toBeNull();
    expect(client.chamadas).toHaveLength(1);
  });
  test('solta as pecas e reabre a encerrada', async () => {
    const client = fakeClient([
      [/SELECT DISTINCT/, [{ condicional_id: COND }]],
      [/SELECT id, status FROM condicionais/, [{ id: COND, status: 'encerrada' }]],
      [/SELECT id, product_id, variant_id, sale_id FROM condicional_itens/, [{ id: I1, sale_id: VENDA }, { id: I2, sale_id: VENDA }]],
    ]);
    const r = await v.voltarAoCancelar(client, { companyId: LOJA, saleId: VENDA, userId: 'u' });
    expect(r).toEqual({ condicional_id: COND, pecas: 2, reabriu: true });
    const sqls = client.chamadas.map((x) => x.sql);
    expect(sqls.some((s) => /SET sale_id = NULL/.test(s))).toBe(true);
    expect(sqls.some((s) => /status = 'aberta', closed_at = NULL/.test(s))).toBe(true);
    expect(sqls.filter((s) => /'venda_cancelada'/.test(s))).toHaveLength(2);
  });
  test('condicional ja aberta: so solta, sem reabrir', async () => {
    const client = fakeClient([
      [/SELECT DISTINCT/, [{ condicional_id: COND }]],
      [/SELECT id, status FROM condicionais/, [{ id: COND, status: 'aberta' }]],
      [/SELECT id, product_id, variant_id, sale_id FROM condicional_itens/, [{ id: I1, sale_id: VENDA }]],
    ]);
    expect((await v.voltarAoCancelar(client, { companyId: LOJA, saleId: VENDA })).reabriu).toBe(false);
  });
});

describe('travas e item removido', () => {
  const ligado = (itens, status = 'encerrada', soma = 1) => fakeClient([
    [/SELECT DISTINCT/, [{ condicional_id: COND }]],
    [/SELECT id, status FROM condicionais/, [{ id: COND, status }]],
    [/SELECT id, product_id, variant_id, sale_id FROM condicional_itens/, itens],
    [/SUM\(quantity\)/, [{ qtd: soma }]],
  ]);
  const par = () => [
    { id: I1, product_id: P1, variant_id: null, sale_id: VENDA },
    { id: I2, product_id: P2, variant_id: null, sale_id: VENDA },
  ];

  test('travarAoCancelar: condicional e depois itens, FOR UPDATE; venda comum = uma consulta', async () => {
    const client = ligado(par());
    const ctx = await v.travarAoCancelar(client, { companyId: LOJA, saleId: VENDA });
    expect(ctx.itens).toHaveLength(2);
    expect(client.chamadas[1].sql).toMatch(/FROM condicionais .* FOR UPDATE$/);
    expect(client.chamadas[2].sql).toMatch(/FROM condicional_itens .* ORDER BY id FOR UPDATE$/);
    const comum = fakeClient([]);
    expect(await v.travarAoCancelar(comum, { companyId: LOJA, saleId: VENDA })).toBeNull();
    expect(comum.chamadas).toHaveLength(1);
  });

  test('item removido: solta so a peca daquele produto, reabre e registra o evento', async () => {
    const client = ligado(par(), 'encerrada', 0);
    const r = await v.soltarPorItemRemovido(client, { companyId: LOJA, saleId: VENDA, productId: P1, variantId: null, userId: 'u' });
    expect(r).toEqual({ condicional_id: COND, pecas: 1, reabriu: true });
    const up = client.chamadas.find((x) => /SET sale_id = NULL/.test(x.sql));
    expect(up.params[2]).toEqual([I1]);
    expect(client.chamadas.filter((x) => /'venda_cancelada'/.test(x.sql))).toHaveLength(1);
  });

  test('item removido com outra unidade ainda na venda: nada solta', async () => {
    const client = ligado(par(), 'aberta', 1);
    expect(await v.soltarPorItemRemovido(client, { companyId: LOJA, saleId: VENDA, productId: P1, variantId: null })).toBeNull();
    expect(client.chamadas.some((x) => /SET sale_id = NULL/.test(x.sql))).toBe(false);
  });

  test('remover A e depois cancelar: o cancelamento solta so B (A nao ganha evento de novo); uuid em maiuscula conta', async () => {
    const client = ligado(par(), 'encerrada', 0);
    const ctx = await v.travarAoCancelar(client, { companyId: LOJA, saleId: VENDA });
    await v.soltarPorItemRemovido(client, { companyId: LOJA, saleId: VENDA, productId: P1, variantId: null, ctx });
    const r = await v.voltarAoCancelar(client, { companyId: LOJA, saleId: VENDA.toUpperCase(), userId: null, ctx });
    expect(r).toEqual({ condicional_id: COND, pecas: 1, reabriu: false });
    const ups = client.chamadas.filter((x) => /SET sale_id = NULL/.test(x.sql));
    expect(ups.map((u) => u.params[2])).toEqual([[I1], [I2]]);
    expect(client.chamadas.filter((x) => /'venda_cancelada'/.test(x.sql))).toHaveLength(2);
  });
});

describe('detalhe: venda_numero', () => {
  test('so a peca cobrada traz o numero da venda', () => {
    const base = { id: 'x', product_id: P1, product_name: 'a', unit_price: '10', situacao: 'ficou', added_at: 'd' };
    const out = c.apresentarCondicional(
      { id: COND, company_id: LOJA, numero: 1, status: 'aberta', due_date: '2026-12-01' },
      [{ ...base, sale_id: VENDA, venda_numero: '1234' }, { ...base, id: 'y', situacao: 'com_cliente', sale_id: null, venda_numero: null }],
      [], { hoje: '2026-11-26' });
    expect(out.items.map((i) => i.venda_numero)).toEqual([1234, null]);
  });
});
