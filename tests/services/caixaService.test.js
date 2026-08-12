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
});
