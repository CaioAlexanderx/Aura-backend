// ============================================================
// AURA. — O dinheiro do pedido de orcamento do Studio (p-185): regras sem banco
// services/financeiroDoOrcamento.js (forma do mark-paid, falta receber), as
// chaves do saldo (sinalDoPedido), o mapa do DRE, a categoria viva e a guarda
// do Financeiro. O dinheiro gravado de verdade esta em
// financeiroDoOrcamento.banco.test.js.
// ============================================================
'use strict';

const F = require('../src/services/financeiroDoOrcamento');
const S = require('../src/services/sinalDoPedido');
const { DEFAULT_LINE_MAP } = require('../src/routes/dre');
const cat = require('../src/services/financeCategories');
const quadro = require('../src/utils/quadroFinanceiro');

describe('lerFormaDoMarco ("Registrar Pix recebido")', () => {
  test('sem forma: Pix (o nome do botao)', () => {
    expect(F.lerFormaDoMarco(undefined)).toBe('pix');
    expect(F.lerFormaDoMarco({})).toBe('pix');
    expect(F.lerFormaDoMarco({ method: '' })).toBe('pix');
  });
  test('vocabulario do Studio (method) e do Caixa (forma)', () => {
    expect(F.lerFormaDoMarco({ method: 'pix' })).toBe('pix');
    expect(F.lerFormaDoMarco({ method: 'cash' })).toBe('dinheiro');
    expect(F.lerFormaDoMarco({ method: 'card' })).toBe('cartao');
    expect(F.lerFormaDoMarco({ forma: 'debito' })).toBe('debito');
    expect(F.lerFormaDoMarco({ forma: 'debito', method: 'pix' })).toBe('debito');
  });
  test("'other' e desconhecida: null (a rota responde 422)", () => {
    expect(F.lerFormaDoMarco({ method: 'other' })).toBeNull();
    expect(F.lerFormaDoMarco({ method: 'boleto' })).toBeNull();
  });
});

describe('chaves, categorias e guarda do saldo', () => {
  test('chaves por pedido, no formato do sinal', () => {
    expect(S.CHAVE_SALDO('x')).toBe('pedido-saldo-x');
    expect(S.CHAVE_TAXA_SALDO('x')).toBe('pedido-saldo-taxa-x');
    expect(S.CATEGORIA_SALDO).toBe('Saldo de pedido');
    expect(F.NOTA).toEqual({ sinal: 'Quitada pelo sinal do pedido', saldo: 'Quitada pelo saldo do pedido' });
  });

  test('DRE: "Saldo de pedido" na receita bruta, a mesma linha do sinal', () => {
    expect(DEFAULT_LINE_MAP['saldo de pedido']).toEqual(DEFAULT_LINE_MAP['sinal de pedido']);
    expect(DEFAULT_LINE_MAP['saldo de pedido']).toMatchObject({ line: 'receita_bruta', group: 'Receita Bruta', sign: 1 });
  });

  test('categoria viva: "Saldo de pedido" e Vendas', () => {
    let n = 0;
    const rows = [];
    cat.linhasDosPadroes(cat.PADROES).forEach((l) => {
      n += 1;
      const pai = l.parent ? rows.find((r) => !r.parent_id && r.kind === l.kind && r.name === l.parent) : null;
      rows.push({ id: 'c' + n, kind: l.kind, parent_id: pai ? pai.id : null, name: l.name, name_norm: cat.normalizarNome(l.name), is_system: l.is_system, archived_at: null });
    });
    const idx = cat.montarIndice(rows);
    expect(cat.resolverTexto('income', 'Saldo de pedido', idx)).toBe(cat.resolverTexto('income', 'Vendas', idx));
  });

  test('o Financeiro nao baixa a mao a entrada do saldo', () => {
    expect(quadro.eDoPedido({ idempotency_key: 'pedido-saldo-1' })).toBe(true);
    expect(quadro.eDoPedido({ idempotency_key: 'pedido-saldo-taxa-1' })).toBe(true);
    expect(quadro.eDoPedido({ idempotency_key: 'saldo-1' })).toBe(false);
  });
});

describe('trava da frente (financeiroDoOrcamentoLigado)', () => {
  afterEach(() => { delete process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO; });
  const q = (ligado) => ({ query: jest.fn(async () => ({ rows: ligado === undefined ? [] : [{ ligado }] })) });

  test('loja de teste (personalizados_teste) liga; a leitura e a do /auth/me, pela loja', async () => {
    const b = q(true);
    expect(await F.financeiroDoOrcamentoLigado(b, 'loja-a')).toBe(true);
    expect(b.query.mock.calls[0][0]).toMatch(/COALESCE\(studio_settings->>'personalizados_teste', ''\) = 'true'/);
    expect(b.query.mock.calls[0][1]).toEqual(['loja-a']);
  });
  test('loja sem a flag, ou sem linha: desligada', async () => {
    expect(await F.financeiroDoOrcamentoLigado(q(false), 'loja-a')).toBe(false);
    expect(await F.financeiroDoOrcamentoLigado(q(undefined), 'loja-a')).toBe(false);
  });
  test("env PERSONALIZADOS_FINANCEIRO_LIBERADO = 'true' (a virada) liga sem ler o banco; outro valor nao", async () => {
    process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO = 'true';
    const b = q(false);
    expect(await F.financeiroDoOrcamentoLigado(b, 'loja-a')).toBe(true);
    expect(b.query).not.toHaveBeenCalled();
    process.env.PERSONALIZADOS_FINANCEIRO_LIBERADO = '1';
    expect(await F.financeiroDoOrcamentoLigado(q(false), 'loja-a')).toBe(false);
  });
  test('desligada: a Producao volta a lista como veio e o cancelamento nao mexe em nada', async () => {
    const b = q(false);
    const lista = [{ id: 'a', d: 'o1' }];
    expect(await F.comFaltaReceber(b, 'loja-a', lista, (o) => o.d)).toBe(lista);
    expect(await F.fecharNoCancelamento(b, { companyId: 'loja-a', orderId: 'o1' })).toBe(false);
    expect(b.query).toHaveBeenCalledTimes(2);
    expect(b.query.mock.calls.every(([s]) => /FROM companies/.test(s))).toBe(true);
  });
});

describe('falta receber na leitura da Producao', () => {
  // A trava responde ligada; as outras consultas, as linhas do teste.
  const fakeQ = (rows) => ({
    query: jest.fn(async (sql) => (/personalizados_teste/.test(String(sql)) ? { rows: [{ ligado: true }] } : { rows })),
  });

  test('total menos o recebido; marcos pendentes com o id do mark-paid; loja na consulta', async () => {
    const q = fakeQ([
      { order_id: 'o1', total: '300.00', status: 'confirmed', recebido: '100.00', pendentes: [{ id: 'p2', kind: 'balance', amount: 200 }] },
      { order_id: 'o2', total: '50.00', status: 'cancelled', recebido: '0', pendentes: [{ id: 'p3', kind: 'deposit', amount: 20 }] },
    ]);
    const m = await F.faltaReceberDosPedidos(q, 'loja-a', ['o1', 'o2', null, 'o1']);
    expect(q.query.mock.calls[0][1]).toEqual(['loja-a', ['o1', 'o2']]);
    expect(q.query.mock.calls[0][0]).toMatch(/studio_quotes sq WHERE sq\.order_id = o\.id AND sq\.company_id = o\.company_id/);
    expect(m.get('o1')).toEqual({
      orcamento_recebido: 100,
      orcamento_falta_receber: 200,
      orcamento_pagamentos_pendentes: [{ id: 'p2', kind: 'balance', amount: 200 }],
    });
    expect(m.get('o2')).toMatchObject({ orcamento_falta_receber: 0, orcamento_pagamentos_pendentes: [] });
  });

  test('sem pedido: nao consulta', async () => {
    const q = fakeQ([]);
    expect((await F.faltaReceberDosPedidos(q, 'loja-a', [])).size).toBe(0);
    expect(q.query).not.toHaveBeenCalled();
  });

  test('comFaltaReceber: pedido fora do orcamento e falha do banco ficam null, sem derrubar a lista', async () => {
    const q = fakeQ([{ order_id: 'o1', total: 10, status: 'confirmed', recebido: 10, pendentes: [] }]);
    const lista = await F.comFaltaReceber(q, 'loja-a', [{ id: 'a', d: 'o1' }, { id: 'b', d: null }], (o) => o.d);
    expect(lista[0]).toMatchObject({ id: 'a', orcamento_falta_receber: 0, orcamento_recebido: 10 });
    expect(lista[1]).toMatchObject({ id: 'b', ...F.NULL_FALTA });

    const quebrado = { query: jest.fn(async () => { throw new Error('caiu'); }) };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const l2 = await F.comFaltaReceber(quebrado, 'loja-a', [{ id: 'a', d: 'o1' }], (o) => o.d);
    expect(l2[0]).toMatchObject({ id: 'a', ...F.NULL_FALTA });
    spy.mockRestore();
  });
});
