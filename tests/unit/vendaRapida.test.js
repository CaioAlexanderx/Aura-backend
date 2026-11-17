// ============================================================
// AURA. -- Testes: pecas da venda com menos idas ao banco (p-141 a p-144)
//
// A igualdade com o caminho de sempre, a concorrencia e as idas ao banco sao
// provadas no Postgres de verdade (__tests__/pdv.vendaRapida.banco.test.js).
// Aqui ficam as decisoes que nao precisam de banco:
//   - quando cada peca se recusa e devolve a venda ao caminho de sempre
//   - o texto exato do envio unico da abertura (nada alem do id da empresa
//     e da chave ja conferidos entra no SQL)
//   - a abertura que falha nao deixa transacao aberta e pausa as tentativas
// ============================================================
const vendaRapida = require('../../src/services/vendaRapida');

const EMPRESA = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0';
const P1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const P2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const V1 = 'cccccccc-dddd-eeee-ffff-000000000000';

let warnSpy;
beforeEach(() => {
  delete process.env.PDV_VENDA_CAMINHO;
  vendaRapida._resetarParaTeste();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warnSpy.mockRestore(); delete process.env.PDV_VENDA_CAMINHO; });

describe('caminhoRapido', () => {
  test.each([
    [undefined, true], ['', true], ['rapido', true], ['qualquer', true],
    ['fila', false], ['FILA', false], [' fila ', false],
  ])('PDV_VENDA_CAMINHO=%j => %s', (valor, esperado) => {
    if (valor === undefined) delete process.env.PDV_VENDA_CAMINHO;
    else process.env.PDV_VENDA_CAMINHO = valor;
    expect(vendaRapida.caminhoRapido()).toBe(esperado);
  });
});

describe('abrir', () => {
  const resultados = (n, { venda = null, settings = { caixa_enabled: true }, sessao = 's-1' } = {}) => {
    const lista = Array.from({ length: n }, () => ({ rows: [] }));
    lista[n - 1] = { rows: [{ pdv_settings: settings, sessao_id: sessao }] };
    if (n === 4) lista[2] = { rows: venda ? [{ id: venda }] : [] };
    return lista;
  };

  test('sem chave: BEGIN + configuracao da loja e sessao do caixa, num envio', async () => {
    const client = { query: jest.fn().mockResolvedValue(resultados(2)) };
    const r = await vendaRapida.abrir(client, { companyId: EMPRESA, idemKey: null });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(params).toBeUndefined();
    const comandos = sql.split(';\n');
    expect(comandos).toHaveLength(2);
    expect(comandos[0]).toBe('BEGIN');
    expect(comandos[1]).toMatch(/SELECT c\.pdv_settings,[\s\S]+FROM caixa_sessoes s[\s\S]+status = 'aberta' LIMIT 1[\s\S]+FROM companies c WHERE c\.id = '08c05f0e-b75b-4c12-870e-d7fb65f1dca0'::uuid$/);
    expect(r).toEqual({ jaFeita: null, contexto: { pdvSettings: { caixa_enabled: true }, sessaoId: 's-1' } });
  });

  test('com chave: a trava vem ANTES da busca da venda, com o mesmo texto de travarEBuscar', async () => {
    const client = { query: jest.fn().mockResolvedValue(resultados(4, { venda: 'sale-9' })) };
    const r = await vendaRapida.abrir(client, { companyId: EMPRESA, idemKey: 'chave_ABC-12345' });

    const comandos = client.query.mock.calls[0][0].split(';\n');
    expect(comandos).toHaveLength(4);
    expect(comandos[0]).toBe('BEGIN');
    expect(comandos[1]).toBe(`SELECT pg_advisory_xact_lock(hashtext('pdv-sale:${EMPRESA}:chave_ABC-12345'::text))`);
    expect(comandos[2]).toBe(`SELECT id FROM sales WHERE company_id = '${EMPRESA}'::uuid AND idempotency_key = 'chave_ABC-12345'::text LIMIT 1`);
    expect(comandos[3]).toMatch(/^SELECT c\.pdv_settings/);
    expect(r.jaFeita).toBe('sale-9');
  });

  test('empresa sem linha: contexto vazio (sem caixa obrigatorio, sem sessao)', async () => {
    const client = { query: jest.fn().mockResolvedValue([{ rows: [] }, { rows: [] }]) };
    const r = await vendaRapida.abrir(client, { companyId: EMPRESA, idemKey: null });
    expect(r).toEqual({ jaFeita: null, contexto: { pdvSettings: null, sessaoId: null } });
    expect(vendaRapida.caixaFechado(r.contexto)).toBe(false);
  });

  test.each([
    ['id da empresa que nao e uuid', { companyId: "x'; DROP TABLE sales; --", idemKey: null }],
    ['id da empresa em maiusculas', { companyId: EMPRESA.toUpperCase(), idemKey: null }],
    ['chave com aspas', { companyId: EMPRESA, idemKey: "abc'; DROP TABLE sales; --" }],
    ['chave curta demais', { companyId: EMPRESA, idemKey: 'abc' }],
    ['chave com espaco', { companyId: EMPRESA, idemKey: 'chave com espaco' }],
  ])('%s: nao monta SQL nenhum, devolve null (a venda abre pelo caminho de sempre)', async (_nome, args) => {
    const client = { query: jest.fn() };
    expect(await vendaRapida.abrir(client, args)).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  test('o envio falha: ROLLBACK, null, e as proximas nem tentam enquanto a pausa dura', async () => {
    const client = {
      query: jest.fn()
        .mockRejectedValueOnce(new Error('varios comandos nao aceitos'))
        .mockResolvedValue({ rows: [] }),
    };
    expect(await vendaRapida.abrir(client, { companyId: EMPRESA, idemKey: null })).toBeNull();
    expect(client.query.mock.calls.map((c) => c[0].split(';')[0])).toEqual(['BEGIN', 'ROLLBACK']);

    const outro = { query: jest.fn() };
    expect(await vendaRapida.abrir(outro, { companyId: EMPRESA, idemKey: null })).toBeNull();
    expect(outro.query).not.toHaveBeenCalled();

    vendaRapida._resetarParaTeste();
    const depois = { query: jest.fn().mockResolvedValue(resultados(2)) };
    expect(await vendaRapida.abrir(depois, { companyId: EMPRESA, idemKey: null })).not.toBeNull();
  });

  test('resposta que nao e um resultado por comando: tratada como falha (nunca pula a busca da chave)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    expect(await vendaRapida.abrir(client, { companyId: EMPRESA, idemKey: 'chave_ABC-12345' })).toBeNull();
    expect(client.query.mock.calls[1][0]).toBe('ROLLBACK');
  });

  test('o ROLLBACK da falha tambem falha: ainda assim devolve null, sem lancar', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('conexao caiu')) };
    await expect(vendaRapida.abrir(client, { companyId: EMPRESA, idemKey: null })).resolves.toBeNull();
  });
});

describe('caixaFechado', () => {
  test.each([
    [{ pdvSettings: { caixa_enabled: true }, sessaoId: null }, true],
    [{ pdvSettings: { caixa_enabled: true }, sessaoId: 's-1' }, false],
    [{ pdvSettings: { caixa_enabled: false }, sessaoId: null }, false],
    [{ pdvSettings: {}, sessaoId: null }, false],
    [{ pdvSettings: null, sessaoId: null }, false],
    [null, false],
  ])('%j => %s', (contexto, esperado) => {
    expect(vendaRapida.caixaFechado(contexto)).toBe(esperado);
  });
});

describe('lerProdutos', () => {
  const ler = (client, items, extra = {}) =>
    vendaRapida.lerProdutos(client, { companyId: EMPRESA, items, comPromocao: false, ...extra });

  test.each([
    ['product_id que nao e uuid', [{ product_id: 'abc', quantity: 1 }]],
    ['product_id em maiusculas', [{ product_id: P1.toUpperCase(), quantity: 1 }]],
    ['product_id numerico', [{ product_id: 12, quantity: 1 }]],
    ['variant_id que nao e uuid', [{ product_id: P1, variant_id: 'xyz', quantity: 1 }]],
  ])('%s: null, sem consulta (a venda le item a item)', async (_nome, items) => {
    const client = { query: jest.fn() };
    expect(await ler(client, items)).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  test('nenhum item com produto: nenhuma consulta, vendedora por conferir', async () => {
    const client = { query: jest.fn() };
    const r = await ler(client, [{ quantity: 1, product_name_snapshot: 'Avulso' }], { employeeId: P2 });
    expect(client.query).not.toHaveBeenCalled();
    expect(r).toEqual({ porItem: [null], vendedora: undefined });
  });

  test('uma consulta para todos os itens; cada linha volta para o seu item pela ordem', async () => {
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [
        // item 0 (P1) e item 3 (P1 de novo, com variacao); o item 2 (P2) nao e visivel.
        { ord: '1', name: 'Caneca', cost_price: '4.00', stock_qty: '20.000', stock_company_id: EMPRESA, variante_id: null, vendedora_id: P2 },
        { ord: '3', name: 'Caneca', cost_price: '4.00', stock_qty: '20.000', stock_company_id: EMPRESA, variante_id: V1, variante_stock_qty: '5.000', variante_sku_suffix: 'P', vendedora_id: P2 },
      ] }),
    };
    const items = [
      { product_id: P1, quantity: 1 },
      { quantity: 1, product_name_snapshot: 'Avulso' },
      { product_id: P2, quantity: 1 },
      { product_id: P1, variant_id: V1, quantity: 1 },
    ];
    const r = await ler(client, items, { employeeId: P2 });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(params).toEqual([[P1, P2, P1], EMPRESA, [null, null, V1], P2]);
    expect(sql).toMatch(/FOR NO KEY UPDATE/);
    expect(r.vendedora).toBe(true);
    expect(r.porItem[0]).toEqual({ p: [{ name: 'Caneca', cost_price: '4.00', stock_qty: '20.000', stock_company_id: EMPRESA }], v: [], marcacao: null });
    expect(r.porItem[1]).toBeNull();
    expect(r.porItem[2]).toEqual({ p: [], v: [], marcacao: null });
    expect(r.porItem[3].v).toEqual([{ stock_qty: '5.000', sku_suffix: 'P' }]);
  });

  test('vendedora que nao e uuid minusculo nao entra na consulta (confere depois, como sempre)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const r = await ler(client, [{ product_id: P1, quantity: 1 }], { employeeId: 'abc' });
    expect(client.query.mock.calls[0][1]).toHaveLength(3);
    expect(r.vendedora).toBeUndefined();
  });

  test('nenhum produto visivel: a vendedora fica por conferir', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const r = await ler(client, [{ product_id: P1, quantity: 1 }], { employeeId: P2 });
    expect(r.vendedora).toBeUndefined();
  });
});

describe('podeGravarDeUmaVez', () => {
  const i = (product_id, quantity, extra = {}) => ({ product_id, quantity, stock_company_id: EMPRESA, ...extra });
  test.each([
    ['linhas de produtos diferentes', [i(P1, 1), i(P2, 2)], true],
    ['linha repetida com quantidades positivas', [i(P1, 1), i(P1, '2.5')], true],
    ['quantidade negativa em linha unica', [i(P1, -1), i(P2, 2)], true],
    ['linha repetida com quantidade negativa', [i(P1, 5), i(P1, -3)], false],
    ['linha repetida com quantidade zero', [i(P1, 5), i(P1, 0)], false],
    ['linha repetida com quantidade que nao e numero', [i(P1, 5), i(P1, 'abc')], false],
    ['linha repetida com quantidade vazia', [i(P1, 5), i(P1, '')], false],
    ['mesma variacao em duas linhas, positivas', [i(P1, 1, { variant_id: V1 }), i(P1, 2, { variant_id: V1 })], true],
    ['produto e a variacao dele: saldos diferentes', [i(P1, 1), i(P1, -2, { variant_id: V1 })], true],
    ['product_id em maiusculas', [i(P1.toUpperCase(), 1)], false],
    ['variant_id que nao e uuid', [i(P1, 1, { variant_id: 'x' })], false],
    ['item avulso (sem produto)', [{ quantity: 1, product_name_snapshot: 'Avulso' }], true],
  ])('%s => %s', (_nome, itens, esperado) => {
    expect(vendaRapida.podeGravarDeUmaVez(itens)).toBe(esperado);
  });
});

describe('gravarItens', () => {
  test('caso que pede o laco de sempre: null e nenhuma consulta', async () => {
    const client = { query: jest.fn() };
    const itens = [
      { product_id: P1, quantity: 5, stock_company_id: EMPRESA },
      { product_id: P1, quantity: -3, stock_company_id: EMPRESA },
    ];
    expect(await vendaRapida.gravarItens(client, { saleId: 's', companyId: EMPRESA, itens, marcacoes: null })).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  test('vendedora e cupom so entram no comando quando a venda tem um ou outro', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'i-1' }] }) };
    const itens = [{ product_id: P1, quantity: 1, unit_price: 10, cost_price: 4, item_discount: 0, line_total: 10, product_name_snapshot: 'Caneca', stock_company_id: EMPRESA }];

    await vendaRapida.gravarItens(client, { saleId: 's', companyId: EMPRESA, itens, marcacoes: null });
    expect(client.query.mock.calls[0][0]).not.toMatch(/UPDATE employees|UPDATE coupons|preco_lista/);
    expect(client.query.mock.calls[0][1]).toHaveLength(10);

    await vendaRapida.gravarItens(client, {
      saleId: 's', companyId: EMPRESA, itens, marcacoes: [{ preco_lista: 12, em_promocao: true }],
      employeeId: P2, totalAmount: 10, couponId: V1,
    });
    const [sql, params] = client.query.mock.calls[1];
    expect(sql).toMatch(/UPDATE employees SET total_sales = COALESCE\(total_sales,0\) \+ 1/);
    expect(sql).toMatch(/UPDATE coupons SET current_uses = current_uses \+ 1/);
    expect(sql).toMatch(/preco_lista, em_promocao/);
    expect(params.slice(10)).toEqual([[12], [true], 10, P2, EMPRESA, V1]);
  });
});

describe('gravarPagamentos', () => {
  const receita = { amount: 30, description: 'Venda PDV - Caneca (pix)', createdBy: 'u1', idempotencyKey: 'pdv-sale-s', saleDate: null, spDateNow: 'CURRENT_DATE' };

  test('sem pagamento e sem receita: nenhuma consulta', async () => {
    const client = { query: jest.fn() };
    await vendaRapida.gravarPagamentos(client, { saleId: 's', companyId: EMPRESA, sessaoId: null, pagamentos: [], receita: null });
    expect(client.query).not.toHaveBeenCalled();
  });

  test('pagamentos e receita: um comando so, na ordem das formas', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await vendaRapida.gravarPagamentos(client, {
      saleId: 's', companyId: EMPRESA, sessaoId: 'sess',
      pagamentos: [{ method: 'pix', amount: 10 }, { method: 'cartao', amount: 20 }], receita,
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO sale_payments[\s\S]+ON CONFLICT DO NOTHING[\s\S]+INSERT INTO transactions[\s\S]+ON CONFLICT \(idempotency_key\) DO NOTHING/);
    expect(params).toEqual(['s', EMPRESA, 'sess', ['pix', 'cartao'], [10, 20], EMPRESA, 30, 'Venda PDV - Caneca (pix)', 'u1', 'pdv-sale-s']);
  });

  test('so pagamentos (sem valor a vista) e so receita', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await vendaRapida.gravarPagamentos(client, { saleId: 's', companyId: EMPRESA, sessaoId: null, pagamentos: [{ method: 'pix', amount: 10 }], receita: null });
    expect(client.query.mock.calls[0][0]).not.toMatch(/INSERT INTO transactions/);
    expect(client.query.mock.calls[0][1]).toEqual(['s', EMPRESA, null, ['pix'], [10]]);

    await vendaRapida.gravarPagamentos(client, { saleId: 's', companyId: EMPRESA, sessaoId: null, pagamentos: [], receita: { ...receita, saleDate: '2026-10-05' } });
    const [sql, params] = client.query.mock.calls[1];
    expect(sql).not.toMatch(/INSERT INTO sale_payments/);
    expect(sql).toMatch(/\$6::date/);
    expect(params).toEqual([EMPRESA, 30, 'Venda PDV - Caneca (pix)', 'u1', 'pdv-sale-s', '2026-10-05']);
  });
});
