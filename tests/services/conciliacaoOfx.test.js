// ============================================================
// Conciliação do extrato da Aura com os repasses da Asaas
// (services/conciliacaoOfx.js).
//
// casarCreditos é pura: as regras (valor exato, ±3 dias, taxa até 5%, um
// pagamento para um crédito) são testadas sem banco. conciliarExtrato e
// conferenciaPorMes rodam sobre o banco de mentira em memória.
// ============================================================
'use strict';

const {
  casarCreditos, conciliarExtrato, conferenciaPorMes, pagamentosAsaas, somaMes,
} = require('../../src/services/conciliacaoOfx');
const fake = require('../helpers/fakeExtratosDb');

const credito = (id, data, valor) => ({ id, data, valor });
const pag = (chave, data_ref, valor, liquido = null) => ({ chave, data_ref, valor, liquido });
const casou = (mapa, id) => (mapa.has(id) ? mapa.get(id) : null);

describe('casarCreditos', () => {
  test('valor exato no mesmo dia e em D+3 casa; "exato" não marca taxa', () => {
    const r = casarCreditos(
      [credito('c1', '2026-10-02', 140.83), credito('c2', '2026-10-08', 169)],
      [pag('pay_1', '2026-10-02', 140.83), pag('pay_2', '2026-10-05', 169)]
    );
    expect(casou(r, 'c1')).toEqual({ chave: 'pay_1', taxa: false });
    expect(casou(r, 'c2')).toEqual({ chave: 'pay_2', taxa: false });
  });

  test('crédito antes do pagamento também vale (±3 dias)', () => {
    const r = casarCreditos([credito('c1', '2026-10-01', 50)], [pag('pay_1', '2026-10-04', 50)]);
    expect(casou(r, 'c1')).toEqual({ chave: 'pay_1', taxa: false });
  });

  test('fora da janela fica pendente (D+4)', () => {
    const r = casarCreditos([credito('c1', '2026-10-09', 169)], [pag('pay_2', '2026-10-05', 169)]);
    expect(r.size).toBe(0);
  });

  test('valor diferente não casa, mesmo na data', () => {
    const r = casarCreditos([credito('c1', '2026-10-02', 140.84)], [pag('pay_1', '2026-10-02', 140.83)]);
    expect(r.size).toBe(0);
  });

  test('com taxa: crédito líquido até 5% abaixo do cobrado casa e marca taxa', () => {
    const r = casarCreditos(
      [credito('c1', '2026-10-12', 96.5), credito('c2', '2026-10-12', 94)],
      [pag('pay_a', '2026-10-11', 100), pag('pay_b', '2026-10-11', 100)]
    );
    // 96,50 é 3,5% abaixo → casa; 94,00 é 6% abaixo → sobra pendente
    expect(casou(r, 'c1')).toEqual({ chave: 'pay_a', taxa: true });
    expect(r.has('c2')).toBe(false);
  });

  test('o limite de 5% é inclusivo', () => {
    const r = casarCreditos([credito('c1', '2026-10-02', 95)], [pag('pay_1', '2026-10-02', 100)]);
    expect(casou(r, 'c1')).toEqual({ chave: 'pay_1', taxa: true });
  });

  test('crédito maior que o cobrado não casa como taxa', () => {
    const r = casarCreditos([credito('c1', '2026-10-02', 101)], [pag('pay_1', '2026-10-02', 100)]);
    expect(r.size).toBe(0);
  });

  test('crédito igual ao líquido informado pela Asaas casa mesmo acima de 5% (boleto de valor baixo)', () => {
    const r = casarCreditos([credito('c1', '2026-10-02', 18.01)], [pag('pay_1', '2026-10-02', 20, 18.01)]);
    expect(casou(r, 'c1')).toEqual({ chave: 'pay_1', taxa: true });
  });

  test('um pagamento só casa com um crédito', () => {
    const r = casarCreditos(
      [credito('c1', '2026-10-07', 169), credito('c2', '2026-10-08', 169)],
      [pag('pay_2', '2026-10-05', 169)]
    );
    expect(r.size).toBe(1);
    expect(casou(r, 'c1')).toEqual({ chave: 'pay_2', taxa: false });
    expect(r.has('c2')).toBe(false);
  });

  test('dois pagamentos iguais: cada crédito leva o mais próximo, sem repetir', () => {
    const r = casarCreditos(
      [credito('c1', '2026-10-06', 169), credito('c2', '2026-10-12', 169)],
      [pag('pay_x', '2026-10-05', 169), pag('pay_y', '2026-10-10', 169)]
    );
    expect(casou(r, 'c1').chave).toBe('pay_x');
    expect(casou(r, 'c2').chave).toBe('pay_y');
  });

  test('um crédito com taxa não rouba o pagamento de um crédito exato', () => {
    // pay_1 (100) serve ao exato c2 (100); c1 (97) só casaria com ele por taxa
    const r = casarCreditos(
      [credito('c1', '2026-10-02', 97), credito('c2', '2026-10-03', 100)],
      [pag('pay_1', '2026-10-02', 100)]
    );
    expect(casou(r, 'c2')).toEqual({ chave: 'pay_1', taxa: false });
    expect(r.has('c1')).toBe(false);
  });

  test('pagamento sem data de referência é ignorado', () => {
    const r = casarCreditos([credito('c1', '2026-10-02', 50)], [pag('pay_1', null, 50)]);
    expect(r.size).toBe(0);
  });

  test('não depende da ordem em que os créditos chegam', () => {
    const creditos = [credito('c1', '2026-10-06', 169), credito('c2', '2026-10-12', 169)];
    const pagamentos = [pag('pay_x', '2026-10-05', 169), pag('pay_y', '2026-10-10', 169)];
    const a = casarCreditos(creditos, pagamentos);
    const b = casarCreditos(creditos.slice().reverse(), pagamentos.slice().reverse());
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});

describe('pagamentosAsaas', () => {
  test('data de referência: creditDate, depois paymentDate, depois o dia do evento', async () => {
    const db = fake.criar({
      pagamentos: [
        fake.pagamento('pay_cartao', '2026-09-01', 100, { credito_em: '2026-10-03', pago_em: '2026-09-01' }),
        fake.pagamento('pay_pix', '2026-10-05', 50, { credito_em: null, pago_em: '2026-10-04' }),
        fake.pagamento('pay_sem', '2026-10-06', 30, { credito_em: null, pago_em: null }),
      ],
    });
    const r = await pagamentosAsaas({ db, de: '2026-09-01', ate: '2026-10-31' });
    expect(r.map((p) => [p.chave, p.data_ref])).toEqual([
      ['pay_cartao', '2026-10-03'], ['pay_pix', '2026-10-04'], ['pay_sem', '2026-10-06'],
    ]);
    expect(r[0]).toMatchObject({ valor: 100, liquido: null, mes: '2026-09' });
  });

  test('por chave: acha pelo id da cobrança ou pelo id do webhook_log', async () => {
    const db = fake.criar({ pagamentos: [fake.pagamento('pay_1', '2026-10-05', 50)] });
    expect((await pagamentosAsaas({ db, chave: 'pay_1' }))).toHaveLength(1);
    expect((await pagamentosAsaas({ db, chave: 'log_pay_1' }))).toHaveLength(1);
    expect((await pagamentosAsaas({ db, chave: 'pay_zzz' }))).toHaveLength(0);
  });
});

describe('conciliarExtrato', () => {
  function cenario() {
    return fake.criar({
      pagamentos: [
        fake.pagamento('pay_a', '2026-10-01', 140.83),
        fake.pagamento('pay_b', '2026-10-05', 169),
        fake.pagamento('pay_c', '2026-10-10', 100, { liquido: '98.01' }),
        fake.pagamento('pay_d', '2026-10-01', 74.17),
        fake.pagamento('pay_ja', '2026-10-02', 60),
      ],
      extratos: [{ id: '1', mes: '2026-10', nome_arquivo: 'out.ofx', total_creditos: '0', linhas: 0 }],
      lancamentos: [
        { id: '1', extrato_id: '1', data: '2026-10-02', valor: '140.83', fitid: 'f1', tipo: 'credito', conciliado_com: null, com_taxa: false, status: 'pendente' },
        { id: '2', extrato_id: '1', data: '2026-10-07', valor: '169.00', fitid: 'f2', tipo: 'credito', conciliado_com: null, com_taxa: false, status: 'pendente' },
        { id: '3', extrato_id: '1', data: '2026-10-08', valor: '169.00', fitid: 'f3', tipo: 'credito', conciliado_com: null, com_taxa: false, status: 'pendente' },
        { id: '4', extrato_id: '1', data: '2026-10-12', valor: '98.01', fitid: 'f4', tipo: 'credito', conciliado_com: null, com_taxa: false, status: 'pendente' },
        { id: '5', extrato_id: '1', data: '2026-10-20', valor: '74.17', fitid: 'f5', tipo: 'credito', conciliado_com: null, com_taxa: false, status: 'pendente' },
        { id: '6', extrato_id: '1', data: '2026-10-14', valor: '12.90', fitid: 'f6', tipo: 'debito', conciliado_com: null, com_taxa: false, status: 'ignorado' },
        // outro extrato já usou pay_ja
        { id: '7', extrato_id: '1', data: '2026-10-03', valor: '60.00', fitid: 'f7', tipo: 'credito', conciliado_com: 'pay_ja', com_taxa: false, status: 'conciliado' },
        { id: '8', extrato_id: '1', data: '2026-10-03', valor: '60.00', fitid: 'f8', tipo: 'credito', conciliado_com: null, com_taxa: false, status: 'pendente' },
      ],
    });
  }

  test('casa exato, com taxa e deixa pendente o que está fora da janela ou sem pagamento livre', async () => {
    const db = cenario();
    const r = await conciliarExtrato({ db, extratoId: '1' });
    expect(r).toEqual({ creditos: 6, conciliados: 3, com_taxa: 1, pendentes: 3 });
    const por = Object.fromEntries(db.estado.lancamentos.map((l) => [l.fitid, [l.status, l.conciliado_com, l.com_taxa]]));
    expect(por.f1).toEqual(['conciliado', 'pay_a', false]);
    expect(por.f2).toEqual(['conciliado', 'pay_b', false]);
    expect(por.f3).toEqual(['pendente', null, false]); // pay_b já casou com f2
    expect(por.f4).toEqual(['conciliado', 'pay_c', true]); // líquido
    expect(por.f5).toEqual(['pendente', null, false]); // 19 dias depois de pay_d
    expect(por.f6).toEqual(['ignorado', null, false]); // débito não entra
    expect(por.f8).toEqual(['pendente', null, false]); // pay_ja é de outro crédito
  });

  test('rodar de novo não casa nada a mais nem desfaz o que casou', async () => {
    const db = cenario();
    await conciliarExtrato({ db, extratoId: '1' });
    const antes = JSON.stringify(db.estado.lancamentos);
    const r = await conciliarExtrato({ db, extratoId: '1' });
    expect(r.conciliados).toBe(0);
    expect(JSON.stringify(db.estado.lancamentos)).toBe(antes);
  });

  test('um pagamento já casado em outro extrato não é oferecido de novo', async () => {
    const db = fake.criar({
      pagamentos: [fake.pagamento('pay_a', '2026-10-01', 50)],
      extratos: [{ id: '1', mes: '2026-10', total_creditos: '0', linhas: 0 }, { id: '2', mes: '2026-10', total_creditos: '0', linhas: 0 }],
      lancamentos: [
        { id: '1', extrato_id: '1', data: '2026-10-02', valor: '50.00', fitid: 'f1', tipo: 'credito', conciliado_com: 'pay_a', com_taxa: false, status: 'conciliado' },
        { id: '2', extrato_id: '2', data: '2026-10-02', valor: '50.00', fitid: 'f1', tipo: 'credito', conciliado_com: null, com_taxa: false, status: 'pendente' },
      ],
    });
    const r = await conciliarExtrato({ db, extratoId: '2' });
    expect(r.conciliados).toBe(0);
    expect(db.estado.lancamentos[1].status).toBe('pendente');
  });

  test('sem crédito pendente não consulta a Asaas', async () => {
    const db = fake.criar({ extratos: [{ id: '1', mes: '2026-10', total_creditos: '0', linhas: 0 }] });
    expect(await conciliarExtrato({ db, extratoId: '1' })).toEqual({ creditos: 0, conciliados: 0, com_taxa: 0, pendentes: 0 });
    expect(db.estado.log.some((s) => s.includes('webhook_logs'))).toBe(false);
  });

  test('a atualização é uma ida ao banco só, não uma por crédito', async () => {
    const db = cenario();
    await conciliarExtrato({ db, extratoId: '1' });
    expect(db.estado.log.filter((s) => s.startsWith('UPDATE'))).toHaveLength(1);
  });
});

describe('conferenciaPorMes', () => {
  const lanc = (id, extrato, valor, status, conciliado_com = null, tipo = 'credito') => ({
    id: String(id), extrato_id: String(extrato), data: '2026-09-10', valor: String(valor), fitid: `f${id}`, tipo, conciliado_com, com_taxa: false, status,
  });

  test('mês sem extrato diz "sem extrato" e ainda mostra o que a Asaas recebeu', async () => {
    const db = fake.criar({ pagamentos: [fake.pagamento('pay_1', '2026-10-05', 169)] });
    const r = await conferenciaPorMes({ db, hoje: '2026-10-13', meses: 3 });
    expect(r.map((m) => m.mes)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(r[2]).toMatchObject({ mes: '2026-10', rotulo: 'Out', asaas: 169, pagamentos: 1, banco: null, diferenca: null, status: 'sem extrato', extratos: [] });
    expect(r[0]).toMatchObject({ asaas: 0, status: 'sem extrato' });
  });

  test('com extrato: banco, diferença e pendências dos dois lados', async () => {
    const db = fake.criar({
      pagamentos: [
        fake.pagamento('pay_1', '2026-09-05', 100),
        fake.pagamento('pay_2', '2026-09-20', 200),
      ],
      extratos: [{ id: '1', mes: '2026-09', nome_arquivo: 'set.ofx', importado_em: '2026-10-02T12:00:00.000Z', total_creditos: '130.00', linhas: 3 }],
      lancamentos: [
        lanc(1, 1, 100, 'conciliado', 'pay_1'),
        lanc(2, 1, 30, 'pendente'),
        lanc(3, 1, 9.9, 'ignorado', null, 'debito'),
      ],
    });
    const [set] = await conferenciaPorMes({ db, hoje: '2026-10-13', meses: 2 });
    expect(set).toMatchObject({
      mes: '2026-09', asaas: 300, banco: 130, diferenca: -170, status: 'pendências',
      conciliado: { n: 1, valor: 100 }, pendentes: { n: 1, valor: 30 }, sem_credito: { n: 1, valor: 200 },
      detalhe: '1 pagamento da Asaas sem crédito (R$ 200,00) · 1 crédito sem pagamento (R$ 30,00)',
    });
    expect(set.extratos).toEqual([{ id: '1', nome_arquivo: 'set.ofx', importado_em: '2026-10-02T12:00:00.000Z', total_creditos: 130, linhas: 3 }]);
  });

  test('tudo casado e nenhum crédito pendente → conciliado', async () => {
    const db = fake.criar({
      pagamentos: [fake.pagamento('pay_1', '2026-09-05', 100)],
      extratos: [{ id: '1', mes: '2026-09', total_creditos: '100.00', linhas: 1 }],
      lancamentos: [lanc(1, 1, 100, 'conciliado', 'pay_1')],
    });
    const [set] = await conferenciaPorMes({ db, hoje: '2026-10-13', meses: 2 });
    expect(set).toMatchObject({ status: 'conciliado', diferenca: 0, detalhe: null });
  });

  test('crédito ignorado de propósito não conta como pendência', async () => {
    const db = fake.criar({
      pagamentos: [fake.pagamento('pay_1', '2026-09-05', 100)],
      extratos: [{ id: '1', mes: '2026-09', total_creditos: '150.00', linhas: 2 }],
      lancamentos: [lanc(1, 1, 100, 'conciliado', 'pay_1'), lanc(2, 1, 50, 'ignorado')],
    });
    const [set] = await conferenciaPorMes({ db, hoje: '2026-10-13', meses: 2 });
    expect(set.status).toBe('conciliado');
  });

  test('meses que o chamador já tem não voltam a ser consultados', async () => {
    const db = fake.criar({});
    const r = await conferenciaPorMes({
      db, hoje: '2026-10-13', meses: 2,
      recebidos: { '2026-09': [{ chave: 'pay_1', valor: 10 }], '2026-10': [{ chave: 'pay_2', valor: 20 }] },
    });
    expect(r.map((m) => m.asaas)).toEqual([10, 20]);
    expect(db.estado.log.some((s) => s.includes('webhook_logs'))).toBe(false);
  });

  test('tabela do extrato ausente (deploy antes da migration) vira "sem extrato"', async () => {
    const erro = Object.assign(new Error('relation "aura_extratos" does not exist'), { code: '42P01' });
    const db = { query: jest.fn(async (sql) => { if (sql.includes('aura_extrato')) throw erro; return { rows: [] }; }) };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await conferenciaPorMes({ db, hoje: '2026-10-13', meses: 2 });
    expect(r.every((m) => m.status === 'sem extrato')).toBe(true);
    console.warn.mockRestore();
  });
});

describe('somaMes', () => {
  test('atravessa o ano', () => {
    expect(somaMes('2026-01', -1)).toBe('2025-12');
    expect(somaMes('2026-10', -5)).toBe('2026-05');
    expect(somaMes('2026-12', 1)).toBe('2027-01');
  });
});
