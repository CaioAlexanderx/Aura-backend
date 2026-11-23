// ============================================================
// AURA. — Caixa: o detalhe da sessão fechada traz os campos do relatório
//
// 23/11/2026 (pedido do Caio): a aba Fechamentos ganha "Imprimir
// fechamento". O relatório do dia usa campos que o /fechar calcula e não
// grava no snapshot (sales_count, new_customers_count, total_vendas,
// total_devolucoes, trocas, trocas_resumo, sessao_label). GET
// /caixa/sessao/:id passa a devolvê-los para a sessão fechada, com as
// mesmas funções e a mesma janela (abertura → fechamento).
//
//   - sessão fechada: os campos vêm, na janela certa;
//   - sessão aberta: nada muda (nem consulta);
//   - erro numa das contas: o detalhe abre do mesmo jeito.
// ============================================================
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn(), connect: jest.fn() }));

const pool = require('../src/config/database');
const caixaService = require('../src/services/caixaService');

const EMPRESA = '3a95021d-62e2-417c-8863-b9c4f0a5e155';
const ABRIU = new Date('2026-11-22T12:00:00Z');
const FECHOU = new Date('2026-11-22T21:30:00Z');
const FECHADA = {
  id: 'ab12cd34-0000-4000-8000-000000000001', company_id: EMPRESA, status: 'fechada',
  opened_at: ABRIU, closed_at: FECHOU, troco_inicial: '100.00', total_geral: '900.00',
};

function banco(sessao, { falhaVendas = false } = {}) {
  pool.query.mockReset();
  pool.query.mockImplementation((sql) => {
    const s = String(sql);
    if (/FROM caixa_sessoes cs/.test(s)) return Promise.resolve({ rows: [sessao] });
    if (/COUNT\(DISTINCT s.id\)/.test(s)) return Promise.resolve({ rows: [{ c: 7 }] });
    if (/SUM\(s.total_amount\)/.test(s)) {
      return falhaVendas ? Promise.reject(new Error('caiu')) : Promise.resolve({ rows: [{ total: '880.00' }] });
    }
    if (/FROM customers/.test(s)) return Promise.resolve({ rows: [{ c: 2 }] });
    if (/FROM troca_payouts tp/.test(s)) return Promise.resolve({ rows: [{ method: 'dinheiro', total: '40.00' }] });
    return Promise.resolve({ rows: [] });
  });
}

const chamadas = (re) => pool.query.mock.calls.filter((c) => re.test(String(c[0])));

beforeEach(() => caixaService._resetCache());

test('sessão fechada: devolve os campos do relatório, na janela da sessão', async () => {
  banco(FECHADA);
  const s = await caixaService.getSessao(EMPRESA, FECHADA.id);
  expect(s).toMatchObject({
    id: FECHADA.id,
    sessao_label: '#AB12C',
    sales_count: 7,
    new_customers_count: 2,
    total_vendas: 880,
    total_devolucoes: 40,
    trocas: [],
    trocas_resumo: { quantidade: 0 },
  });
  const [vendas] = chamadas(/SUM\(s.total_amount\)/);
  expect(vendas[1]).toEqual([EMPRESA, ABRIU, FECHOU]);
  const [payouts] = chamadas(/FROM troca_payouts tp/);
  expect(payouts[1]).toEqual([EMPRESA, FECHADA.id, ABRIU, FECHOU]);
});

test('sessão aberta: detalhe de sempre, sem as contas do relatório', async () => {
  banco({ ...FECHADA, status: 'aberta', closed_at: null });
  const s = await caixaService.getSessao(EMPRESA, FECHADA.id);
  expect(s.sales_count).toBeUndefined();
  expect(s.trocas).toBeUndefined();
  expect(chamadas(/SUM\(s.total_amount\)/)).toHaveLength(0);
});

test('uma conta falha: o detalhe abre e o resto vem', async () => {
  banco(FECHADA, { falhaVendas: true });
  const s = await caixaService.getSessao(EMPRESA, FECHADA.id);
  expect(s.total_vendas).toBe(0);
  expect(s.sales_count).toBe(7);
});
