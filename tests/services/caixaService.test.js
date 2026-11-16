// ============================================================
// AURA. — Testes: src/services/caixaService.js
// Fix 12/08/2026 — fechamento de caixa × troca v2 (caso Davi 11/08).
//
// Mock por SQL (mockImplementation casando o texto da query), nunca
// fila posicional. beforeEach com resetAllMocks — nunca clearAllMocks.
//
// Contexto do bug: trocaV2.insertSalePayments grava uma row NEGATIVA de
// -returnedValue em sale_payments (artefato de "faturamento líquido"
// entre sessões, PR #55), mas os splits positivos da troca já são o
// líquido pago. calcularTotais somava tudo → cada troca subtraía a
// devolução 2× do fechamento (Villa Branca 11/08: R$40 impresso num dia
// com R$229,99 de entradas; troca par-a-par na Matriz: -R$159,99).
// ============================================================

jest.mock('../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require('../../src/config/database');
const caixaService = require('../../src/services/caixaService');

const COMPANY = 'ea68b4d2-f051-46b1-9ac5-b8438c6cd5fc';
const SESSAO = '14e73ece-98e3-4003-a33b-200665077fe3';

// Roteia pool.query por conteúdo da SQL. handlers: [[regex, fn(sql, params)]]
function routeQueries(handlers) {
  pool.query.mockImplementation((sql, params) => {
    for (const [pattern, fn] of handlers) {
      if (pattern.test(sql)) return Promise.resolve(fn(sql, params));
    }
    return Promise.resolve({ rows: [] });
  });
}

// Handlers base: caixa habilitado + sessão aberta. Cada teste adiciona
// os handlers de sale_payments / troca_payouts do cenário.
function baseHandlers() {
  return [
    [/caixa_enabled/, () => ({ rows: [{ caixa_enabled: 'true' }] })],
    [/FROM caixa_sessoes cs/, () => ({
      rows: [{
        id: SESSAO,
        company_id: COMPANY,
        opened_at: '2026-08-11T17:04:23.285Z',
        troco_inicial: '0.00',
        status: 'aberta',
        opened_by: 'user-1',
        opened_by_employee_id: null,
        operator_name: 'Davi',
        operator_id: 'user-1',
      }],
    })],
  ];
}

function capturedSql(pattern) {
  const call = pool.query.mock.calls.find(([sql]) => pattern.test(sql));
  return call ? call[0] : null;
}

beforeEach(() => jest.resetAllMocks());

describe('calcularTotais (via getStatus) — SQL de sale_payments', () => {
  test('exclui a row negativa de troca e vendas canceladas NA PRÓPRIA QUERY', async () => {
    routeQueries(baseHandlers());
    await caixaService.getStatus(COMPANY);

    const sql = capturedSql(/FROM sale_payments sp/);
    expect(sql).toBeTruthy();
    // Guarda do fix 12/08: a row -returnedValue da trocaV2 NÃO pode entrar
    // na soma por método da sessão.
    expect(sql).toMatch(/NOT \(sp\.amount < 0 AND COALESCE\(s\.type, 'sale'\) = 'troca'\)/);
    // Pagamento de venda cancelada não conta no caixa.
    expect(sql).toMatch(/<> 'cancelled'/);
  });
});

describe('calcularTotais — caso Davi 11/08 (troca com diferença paga em pix)', () => {
  test('fechamento soma o que ENTROU (100 pix + 129,99 cartão), não o líquido menos devolução', async () => {
    // Pós-fix, a query de sale_payments devolve só as rows válidas:
    // pix +100 (diferença da troca) e cartao +129.99 (venda normal).
    routeQueries([
      ...baseHandlers(),
      [/FROM sale_payments sp/, () => ({
        rows: [
          { method: 'pix', total: '100.00' },
          { method: 'cartao', total: '129.99' },
        ],
      })],
    ]);

    const status = await caixaService.getStatus(COMPANY);
    const t = status.sessao_ativa.totais_ao_vivo;

    expect(t.pix).toBe(100);
    expect(t.cartao_credito).toBe(129.99);
    expect(t.dinheiro).toBe(0);
    expect(t.geral).toBe(229.99); // era 40.00 com a row -189.99 entrando na soma
    expect(t.devolucoes).toBe(0);
  });

  test('troca par-a-par (caso Matriz 11/08) fecha em zero, não em -159,99', async () => {
    // Par-a-par: nenhum split positivo; a única row era a negativa,
    // agora excluída pela query → sale_payments vazio.
    routeQueries([
      ...baseHandlers(),
      [/FROM sale_payments sp/, () => ({ rows: [] })],
    ]);

    const status = await caixaService.getStatus(COMPANY);
    const t = status.sessao_ativa.totais_ao_vivo;
    expect(t.dinheiro).toBe(0);
    expect(t.geral).toBe(0);
  });
});

describe('calcularTotais — troca_payouts (reembolso real ao cliente)', () => {
  test('reembolso em dinheiro desconta o bucket dinheiro (e o dinheiro_esperado)', async () => {
    routeQueries([
      ...baseHandlers(),
      [/FROM sale_payments sp/, () => ({ rows: [{ method: 'dinheiro', total: '200.00' }] })],
      [/FROM troca_payouts tp/, () => ({ rows: [{ method: 'dinheiro', total: '50.00' }] })],
    ]);

    const status = await caixaService.getStatus(COMPANY);
    const t = status.sessao_ativa.totais_ao_vivo;
    expect(t.dinheiro).toBe(150);
    expect(t.geral).toBe(150);
    expect(t.devolucoes).toBe(50);
  });

  test('crediario_credito NÃO desconta (crédito na carteira, nada sai da gaveta)', async () => {
    routeQueries([
      ...baseHandlers(),
      [/FROM sale_payments sp/, () => ({ rows: [{ method: 'pix', total: '80.00' }] })],
      [/FROM troca_payouts tp/, () => ({ rows: [{ method: 'crediario_credito', total: '60.00' }] })],
    ]);

    const status = await caixaService.getStatus(COMPANY);
    const t = status.sessao_ativa.totais_ao_vivo;
    expect(t.pix).toBe(80);
    expect(t.geral).toBe(80);
    expect(t.devolucoes).toBe(0);
  });

  test('tabela troca_payouts ausente (42P01) é non-fatal — deploy parcial', async () => {
    routeQueries([
      ...baseHandlers(),
      [/FROM sale_payments sp/, () => ({ rows: [{ method: 'pix', total: '80.00' }] })],
      [/FROM troca_payouts tp/, () => { throw Object.assign(new Error('undefined_table'), { code: '42P01' }); }],
    ]);

    const status = await caixaService.getStatus(COMPANY);
    expect(status.sessao_ativa.totais_ao_vivo.pix).toBe(80);
    expect(status.sessao_ativa.totais_ao_vivo.devolucoes).toBe(0);
  });
});

describe('fechar — snapshot e métricas', () => {
  function mockClientOk() {
    const client = {
      query: jest.fn((sql) => {
        if (/INSERT INTO caixa_fechamentos/.test(sql)) {
          return Promise.resolve({ rows: [{ id: 'fech-1', sessao_id: SESSAO, diferenca: '0.00' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
    return client;
  }

  test('dinheiro_esperado usa o dinheiro LÍQUIDO de reembolsos; resposta traz total_vendas e total_devolucoes', async () => {
    routeQueries([
      ...baseHandlers(),
      [/FROM sale_payments sp/, () => ({ rows: [{ method: 'dinheiro', total: '200.00' }] })],
      [/FROM troca_payouts tp/, () => ({ rows: [{ method: 'dinheiro', total: '50.00' }] })],
      // métricas
      [/COUNT\(DISTINCT s\.id\)/, () => ({ rows: [{ c: 2 }] })],
      [/SUM\(s\.total_amount\)/, () => ({ rows: [{ total: '419.98' }] })],
      [/FROM customers/, () => ({ rows: [{ c: 1 }] })],
    ]);
    const client = mockClientOk();

    const fechamento = await caixaService.fechar(COMPANY, 'user-1', 150, null);

    // INSERT do snapshot: dinheiro_esperado = troco(0) + dinheiro líquido(150)
    const insertCall = client.query.mock.calls.find(([sql]) => /INSERT INTO caixa_fechamentos/.test(sql));
    expect(insertCall).toBeTruthy();
    const params = insertCall[1];
    expect(params[1]).toBe(150);    // dinheiro_esperado
    expect(params[7]).toBe(150);    // total_dinheiro
    expect(params[9]).toBe(150);    // total_geral

    expect(fechamento.total_vendas).toBe(419.98);
    expect(fechamento.total_devolucoes).toBe(50);
    expect(fechamento.sales_count).toBe(2);
  });

  test('sales_count conta vendas completed (era status=\'active\' e saía 0 sempre)', async () => {
    routeQueries([
      ...baseHandlers(),
      [/FROM sale_payments sp/, () => ({ rows: [] })],
      [/COUNT\(DISTINCT s\.id\)/, () => ({ rows: [{ c: 3 }] })],
    ]);
    mockClientOk();

    const fechamento = await caixaService.fechar(COMPANY, 'user-1', 0, null);

    const sql = capturedSql(/COUNT\(DISTINCT s\.id\)/);
    expect(sql).toMatch(/<> 'cancelled'/);
    expect(sql).not.toMatch(/= 'active'/);
    expect(fechamento.sales_count).toBe(3);
  });
  // 16/11/2026 (INC-2026-11-16-01, Look das Patroas 14/11): a troca entrava
  // em "Vendas do período" com o valor cheio da peça nova (199,80), e a
  // peça devolvida (139,90) já tinha sido vendida antes.
  test('Vendas do período e a contagem de vendas não somam a troca', async () => {
    routeQueries([
      ...baseHandlers(),
      [/FROM sale_payments sp/, () => ({ rows: [] })],
      [/COUNT\(DISTINCT s\.id\)/, () => ({ rows: [{ c: 43 }] })],
      [/SUM\(s\.total_amount\)/, () => ({ rows: [{ total: '10525.08' }] })],
    ]);
    mockClientOk();

    const fechamento = await caixaService.fechar(COMPANY, 'user-1', 0, null);

    const sqlVendas = capturedSql(/SUM\(s\.total_amount\)/);
    const sqlContagem = capturedSql(/COUNT\(DISTINCT s\.id\)/);
    for (const sql of [sqlVendas, sqlContagem]) {
      expect(sql).toMatch(/COALESCE\(s\.type, 'sale'\) <> 'troca'/);
      expect(sql).toMatch(/<> 'cancelled'/);
    }
    expect(fechamento.total_vendas).toBe(10525.08);
    expect(fechamento.sales_count).toBe(43);
  });
});


// 16/11/2026: o fechamento devolve as trocas e devoluções da sessão, para o
// relatório e a tela explicarem por que "Vendas do período" e "Entradas no
// caixa" diferem. Fora do snapshot caixa_fechamentos.
describe('fechar — trocas e devoluções da sessão', () => {
  function mockClientOk() {
    const client = {
      query: jest.fn((sql) => {
        if (/INSERT INTO caixa_fechamentos/.test(sql)) {
          return Promise.resolve({ rows: [{ id: 'fech-1', sessao_id: SESSAO, diferenca: '0.00' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      release: jest.fn(),
    };
    pool.connect.mockResolvedValue(client);
    return client;
  }

  // cenario: { trocas: [{ id, created_at }], dev, lev, rec, po } — as rows
  // que cada consulta devolve.
  function trocaHandlers(c) {
    return [
      [/WITH da_sessao/, () => ({ rows: c.trocas })],
      [/FROM troca_returned_items tri/, () => {
        if (c.devErro) throw c.devErro;
        return { rows: c.dev || [] };
      }],
      [/FROM sale_items si/, () => ({ rows: c.lev || [] })],
      [/FROM sale_payments pay\s+WHERE pay\.sale_id/, () => ({ rows: c.rec || [] })],
      [/FROM troca_payouts po\s+WHERE po\.troca_sale_id/, () => ({ rows: c.po || [] })],
    ];
  }

  async function fecharCom(cenario) {
    routeQueries([...trocaHandlers(cenario), ...baseHandlers()]);
    const client = mockClientOk();
    const fechamento = await caixaService.fechar(COMPANY, 'user-1', 0, null);
    return { fechamento, client };
  }

  const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
  const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';

  test('troca com diferença paga: devolveu 139,90, levou 79,90 + 119,90, recebeu 59,90 no débito', async () => {
    const { fechamento, client } = await fecharCom({
      trocas: [{ id: T1, created_at: '2026-11-14T15:33:00.000Z' }],
      dev: [{ troca_sale_id: T1, product_name_snapshot: 'Conjunto de linho (Azul · M)', quantity: '1.0000', unit_price: '139.90' }],
      lev: [
        { sale_id: T1, variant_id: null, quantity: '1.0000', unit_price: '79.90', total_price: '79.90', product_name: 'Blusa com strass' },
        {
          sale_id: T1, variant_id: 'v-1', quantity: '1.0000', unit_price: '119.90', total_price: '119.90',
          product_name: 'Blusa casual', variant_label: 'BRANCA-P', variant_color_name: 'Branca',
          variant_attrs: [{ attribute: 'Cor', value: 'Branca' }, { attribute: 'Tamanho', value: 'P' }],
        },
      ],
      rec: [{ sale_id: T1, method: 'debito', total: '59.90' }],
    });

    expect(fechamento.trocas).toEqual([{
      id: T1,
      created_at: '2026-11-14T15:33:00.000Z',
      tipo: 'troca',
      devolvidos: [{ product_name_snapshot: 'Conjunto de linho (Azul · M)', quantity: 1, unit_price: 139.9 }],
      levados: [
        { product_name: 'Blusa com strass', quantity: 1, unit_price: 79.9, total_price: 79.9 },
        { product_name: 'Blusa casual (Branca · P)', quantity: 1, unit_price: 119.9, total_price: 119.9 },
      ],
      recebido: { total: 59.9, metodos: [{ method: 'debito', amount: 59.9 }] },
      devolvido_cliente: { total: 0, metodos: [] },
      credito_carteira: 0,
    }]);
    expect(fechamento.trocas_resumo).toEqual({
      quantidade: 1, pecas_devolvidas: 139.9, pecas_levadas: 199.8, diferenca_recebida: 59.9, devolvido_cliente: 0,
    });

    // "Recebido" é só o que entrou: a row negativa da trocaV2 fica de fora.
    expect(capturedSql(/FROM sale_payments pay\s+WHERE pay\.sale_id/)).toMatch(/pay\.amount > 0/);
    // A troca da sessão sai do sessao_id dos pagamentos E dos payouts, sem
    // cancelada; o filtro de empresa fica no pagamento (multi-CNPJ).
    const sqlTrocas = capturedSql(/WITH da_sessao/);
    expect(sqlTrocas).toMatch(/FROM sale_payments pay\s+WHERE pay\.sessao_id = \$2 AND pay\.company_id = \$1/);
    expect(sqlTrocas).toMatch(/FROM troca_payouts po\s+WHERE po\.sessao_id = \$2 AND po\.company_id = \$1/);
    expect(sqlTrocas).toMatch(/COALESCE\(s\.type, 'sale'\) = 'troca'/);
    expect(sqlTrocas).toMatch(/<> 'cancelled'/);
    expect(pool.query.mock.calls.find(([sql]) => /WITH da_sessao/.test(sql))[1]).toEqual([COMPANY, SESSAO]);

    // O snapshot não muda: nenhuma coluna de troca no INSERT.
    const insertCall = client.query.mock.calls.find(([sql]) => /INSERT INTO caixa_fechamentos/.test(sql));
    expect(insertCall[0]).not.toMatch(/troca/);
  });

  test('troca com devolução em dinheiro ao cliente (0,10)', async () => {
    const { fechamento } = await fecharCom({
      trocas: [{ id: T1, created_at: '2026-11-15T14:06:00.000Z' }],
      dev: [{ troca_sale_id: T1, product_name_snapshot: 'Blusa casual (Branca · P)', quantity: '1', unit_price: '119.90' }],
      lev: [{ sale_id: T1, variant_id: null, quantity: '2', unit_price: '59.90', total_price: '119.80', product_name: 'Blusa decote quadrado' }],
      po: [{ troca_sale_id: T1, method: 'dinheiro', total: '0.10' }],
    });
    const [t] = fechamento.trocas;
    expect(t.tipo).toBe('troca');
    expect(t.levados).toEqual([{ product_name: 'Blusa decote quadrado', quantity: 2, unit_price: 59.9, total_price: 119.8 }]);
    expect(t.recebido).toEqual({ total: 0, metodos: [] });
    expect(t.devolvido_cliente).toEqual({ total: 0.1, metodos: [{ method: 'dinheiro', amount: 0.1 }] });
    expect(t.credito_carteira).toBe(0);
    expect(fechamento.trocas_resumo).toEqual({
      quantidade: 1, pecas_devolvidas: 119.9, pecas_levadas: 119.8, diferenca_recebida: 0, devolvido_cliente: 0.1,
    });
  });

  test('troca par a par: sem diferença nem devolução', async () => {
    const { fechamento } = await fecharCom({
      trocas: [{ id: T1, created_at: '2026-11-15T14:42:00.000Z' }],
      dev: [{ troca_sale_id: T1, product_name_snapshot: 'Cropped regata (Azul)', quantity: '1', unit_price: '49.90' }],
      lev: [{ sale_id: T1, variant_id: null, quantity: '1', unit_price: '49.90', total_price: '49.90', product_name: 'Cropped regata' }],
    });
    const [t] = fechamento.trocas;
    expect(t.tipo).toBe('troca');
    expect(t.recebido.total).toBe(0);
    expect(t.devolvido_cliente.total).toBe(0);
    expect(t.credito_carteira).toBe(0);
    expect(fechamento.trocas_resumo.diferenca_recebida).toBe(0);
    expect(fechamento.trocas_resumo.devolvido_cliente).toBe(0);
  });

  test('crédito na carteira não conta como devolvido ao cliente', async () => {
    const { fechamento } = await fecharCom({
      trocas: [{ id: T1, created_at: '2026-11-16T18:20:00.000Z' }],
      dev: [{ troca_sale_id: T1, product_name_snapshot: 'Vestido longo estampado', quantity: '1', unit_price: '129.90' }],
      lev: [{ sale_id: T1, variant_id: null, quantity: '1', unit_price: '119.90', total_price: '119.90', product_name: 'Blusa casual' }],
      po: [{ troca_sale_id: T1, method: 'crediario_credito', total: '10.00' }],
    });
    const [t] = fechamento.trocas;
    expect(t.credito_carteira).toBe(10);
    expect(t.devolvido_cliente).toEqual({ total: 0, metodos: [] });
    expect(fechamento.trocas_resumo.devolvido_cliente).toBe(0);
  });

  test('devolução sem levar peça vira tipo devolucao; duas trocas somam no resumo', async () => {
    const { fechamento } = await fecharCom({
      trocas: [
        { id: T1, created_at: '2026-11-16T14:06:00.000Z' },
        { id: T2, created_at: '2026-11-16T20:05:00.000Z' },
      ],
      dev: [
        { troca_sale_id: T1, product_name_snapshot: 'Blusa casual', quantity: '1', unit_price: '119.90' },
        { troca_sale_id: T2, product_name_snapshot: 'Short jeans (42)', quantity: '1', unit_price: '119.90' },
      ],
      lev: [{ sale_id: T1, variant_id: null, quantity: '1', unit_price: '139.90', total_price: '139.90', product_name: 'Vestido midi' }],
      rec: [{ sale_id: T1, method: 'pix', total: '20.00' }],
      po: [{ troca_sale_id: T2, method: 'pix', total: '119.90' }],
    });
    expect(fechamento.trocas.map((t) => t.tipo)).toEqual(['troca', 'devolucao']);
    expect(fechamento.trocas[1].levados).toEqual([]);
    expect(fechamento.trocas[1].devolvido_cliente).toEqual({ total: 119.9, metodos: [{ method: 'pix', amount: 119.9 }] });
    expect(fechamento.trocas_resumo).toEqual({
      quantidade: 2, pecas_devolvidas: 239.8, pecas_levadas: 139.9, diferenca_recebida: 20, devolvido_cliente: 119.9,
    });
  });

  test('sessão sem troca: trocas [] e nenhuma consulta de itens', async () => {
    const { fechamento } = await fecharCom({ trocas: [] });
    expect(fechamento.trocas).toEqual([]);
    expect(fechamento.trocas_resumo).toEqual({
      quantidade: 0, pecas_devolvidas: 0, pecas_levadas: 0, diferenca_recebida: 0, devolvido_cliente: 0,
    });
    expect(capturedSql(/FROM troca_returned_items tri/)).toBeNull();
    expect(capturedSql(/FROM sale_items si/)).toBeNull();
  });

  test('tabela da troca ausente (42P01) é non-fatal: trocas []', async () => {
    routeQueries([
      [/WITH da_sessao/, () => { throw Object.assign(new Error('undefined_table'), { code: '42P01' }); }],
      ...baseHandlers(),
    ]);
    mockClientOk();
    const fechamento = await caixaService.fechar(COMPANY, 'user-1', 0, null);
    expect(fechamento.trocas).toEqual([]);
    expect(fechamento.trocas_resumo.quantidade).toBe(0);
  });

  test('erro inesperado na leitura das trocas não derruba o fechamento já gravado', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { fechamento } = await fecharCom({
      trocas: [{ id: T1, created_at: '2026-11-16T14:06:00.000Z' }],
      devErro: new Error('connection reset'),
    });
    expect(fechamento.id).toBe('fech-1');
    expect(fechamento.trocas).toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
