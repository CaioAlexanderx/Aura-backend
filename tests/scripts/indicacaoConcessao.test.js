// ============================================================
// scripts/indicacao-concessao.js — concessão do mês do indicador (t2-19)
//
// Banco e Asaas mockados (tests/helpers/fakeIndicacao.js). Cobre o que a
// Célia pediu: dry-run não escreve; grava a concessão ANTES de excluir;
// teto mensal e anual; indicador em atraso; só cobrança futura e pendente;
// rodar duas vezes não duplica; estorno; combinada fora do teto.
// ============================================================
'use strict';

const lib = require('../../scripts/indicacao-lib');
const { executar, confere, lerArgs } = require('../../scripts/indicacao-concessao');
const { HOJE, fakeDb, fakeAsaas, par, juntar } = require('../helpers/fakeIndicacao');

const silencio = () => {};
beforeEach(() => { jest.spyOn(console, 'table').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

function cenario(pares, { concessoes = [], atrasadas = {}, falharDelete = null, falharPost = null, empresas = [], asaasOpts = {} } = {}) {
  const ordem = [];
  const d = juntar(pares);
  const db = fakeDb({ candidatos: d.candidatos, eventos: d.eventos, concessoes, empresas, ordem });
  const asaas = fakeAsaas({ pendentes: d.pendentes, atrasadas, falharDelete, falharPost, ordem, ...asaasOpts });
  return { db, asaas, ordem };
}

// Responde a confirmação digitando o valor que o próprio texto pede.
const digitaOValor = jest.fn(async (texto) => (texto.match(/digite o valor \(([\d.,]+)\)/) || [])[1] || '');
const rodar = (argv, { db, asaas }, extra = {}) => executar(argv, {
  db, asaas, perguntar: digitaOValor, hoje: HOJE, log: silencio, interativo: true, ...extra,
});
const deletes = (asaas) => asaas.mock.calls.filter(([m]) => m === 'DELETE');
const mutacoesNaAsaas = (asaas) => asaas.mock.calls.filter(([m]) => m !== 'GET');

describe('dry-run (padrão)', () => {
  test('mostra a fila e não escreve nada, nem no banco nem na Asaas', async () => {
    const c = cenario([par()]);
    const r = await rodar([], c);
    expect(r).toEqual({ modo: 'dry-run', prontas: 1 });
    expect(c.db.escritas()).toEqual([]);
    expect(mutacoesNaAsaas(c.asaas)).toEqual([]);
    expect(digitaOValor).not.toHaveBeenCalled();
  });

  test('sem chave da Asaas: lista as elegíveis sem valor e não quebra', async () => {
    const c = cenario([par()]);
    const r = await rodar([], { db: c.db, asaas: null });
    expect(r.prontas).toBe(0);
    expect(c.db.escritas()).toEqual([]);
  });

  test('--apply exige terminal interativo e chave da Asaas', async () => {
    const c = cenario([par()]);
    await expect(rodar(['--apply'], c, { interativo: false })).rejects.toThrow(/terminal interativo/);
    await expect(rodar(['--apply'], { db: c.db, asaas: null })).rejects.toThrow(/ASAAS_API_KEY/);
    expect(c.db.escritas()).toEqual([]);
  });

  test('--apply e --dry-run juntos são recusados', () => {
    expect(() => lerArgs(['--apply', '--dry-run'])).toThrow(/Escolha um/);
  });
});

describe('--apply: grava a concessão ANTES de excluir', () => {
  test('ordem: confere na Asaas → grava (registrada) → exclui → marca aplicada', async () => {
    const p = par({ indicadorValor: 93.17 });
    const c = cenario([p]);
    const r = await rodar(['--apply'], c);

    expect(r.concedidas).toBe(1);
    const i = (s) => c.ordem.indexOf(s);
    const del = `asaas:DELETE /payments/pay_a${p.n}_prox`;
    expect(i(`asaas:GET /payments/pay_a${p.n}_prox`)).toBeLessThan(i('db:inserir'));
    expect(i('db:inserir')).toBeLessThan(i('db:COMMIT'));
    expect(i('db:COMMIT')).toBeLessThan(i(del));
    expect(i(del)).toBeLessThan(i('db:aplicada'));

    const [k] = c.db.estado.concessoes;
    expect(k).toMatchObject({
      tipo: 'padrao', status: 'aplicada', valor: 93.17, asaas_payment_id: `pay_a${p.n}_prox`,
      indicador_company_id: p.a, indicado_company_id: p.b, data_concessao: HOJE,
      cobranca_vencimento: '2026-11-15', indicado_payment_id: `pay_b${p.n}_1`, indicado_pago_em: '2026-10-05',
    });
  });

  test('a confirmação mostra indicador e valor; valor digitado errado não faz nada', async () => {
    const c = cenario([par()]);
    const perguntar = jest.fn(async () => '93,18');
    const r = await rodar(['--apply'], c, { perguntar });
    expect(perguntar.mock.calls[0][0]).toMatch(/Indicador : Loja A\d+/);
    expect(perguntar.mock.calls[0][0]).toMatch(/R\$ 93,17/);
    expect(r.concedidas).toBe(0);
    expect(c.db.escritas()).toEqual([]);
    expect(deletes(c.asaas)).toEqual([]);
  });

  test('a Asaas recusa a exclusão: a linha fica como falhou e não ocupa o teto', async () => {
    const c = cenario([par()], { falharDelete: 'Asaas error 400' });
    const r = await rodar(['--apply'], c);
    expect(r.concedidas).toBe(0);
    expect(c.db.estado.concessoes[0]).toMatchObject({ status: 'falhou', erro: 'Asaas error 400' });
    expect(lib.usoDoTeto(c.db.estado.concessoes, HOJE).usadoMes).toBe(0);
  });

  test('a cobrança mudou entre a lista e a confirmação: recusa sem gravar nem excluir', async () => {
    const p = par();
    const c = cenario([p]);
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    const item = fila.itens.find((it) => it.situacao === 'pronta');
    c.asaas.cobrancas.get(item.cobranca.id).value = 150; // reajuste na Asaas
    await expect(lib.concederUma({ db: c.db, asaas: c.asaas, item, hoje: HOJE })).rejects.toThrow(/valor da cobrança mudou/);
    expect(c.db.escritas()).toEqual([]);
    expect(deletes(c.asaas)).toEqual([]);
  });

  test('confere(): aceita 93,17, 93.17 e R$ 93,17; recusa vazio e outro valor', () => {
    expect(confere('93,17', 93.17)).toBe(true);
    expect(confere('93.17', 93.17)).toBe(true);
    expect(confere('R$ 93,17', 93.17)).toBe(true);
    expect(confere('1.093,17', 1093.17)).toBe(true);
    expect(confere('', 93.17)).toBe(false);
    expect(confere('sim', 93.17)).toBe(false);
    expect(confere('93', 93.17)).toBe(false);
  });
});

describe('idempotência', () => {
  test('rodar --apply duas vezes concede uma vez só', async () => {
    const c = cenario([par()]);
    await rodar(['--apply'], c);
    const r2 = await rodar(['--apply'], c);
    expect(r2.concedidas).toBe(0);
    expect(c.db.estado.concessoes).toHaveLength(1);
    expect(deletes(c.asaas)).toHaveLength(1);
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.itens[0].situacao).toBe('concedida');
  });

  test('item velho (outra pessoa concedeu no meio): a trava dentro da transação recusa', async () => {
    const c = cenario([par()]);
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    const item = fila.itens.find((it) => it.situacao === 'pronta');
    await lib.concederUma({ db: c.db, asaas: c.asaas, item, hoje: HOJE });
    c.asaas.cobrancas.get(item.cobranca.id).deleted = false; // finge que a Asaas ainda a mostra
    await expect(lib.concederUma({ db: c.db, asaas: c.asaas, item, hoje: HOJE })).rejects.toThrow(/já tem concessão/);
    expect(c.db.estado.concessoes).toHaveLength(1);
    expect(deletes(c.asaas)).toHaveLength(1);
  });

  test('concessão que ficou registrada (sem confirmação) não é concedida de novo', async () => {
    const p = par();
    const c = cenario([p], {
      concessoes: [{ id: 'k1', status: 'registrada', referral_id: p.candidato.referral_id, indicador_company_id: p.a,
        indicado_company_id: p.b, data_concessao: HOJE, valor: 93.17, asaas_payment_id: `pay_a${p.n}_prox` }],
    });
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.itens[0].situacao).toBe('em_conferencia');
  });
});

describe('teto mensal (R$ 230) e anual (3 por indicador)', () => {
  test('fila pela data do pagamento do indicado: o segundo de R$ 140,83 espera o mês seguinte', async () => {
    const primeiro = par({ indicadorValor: 140.83, indicadoPagouEm: '2026-10-02' });
    const segundo = par({ indicadorValor: 140.83, indicadoPagouEm: '2026-10-08' });
    const c = cenario([segundo, primeiro]); // ordem de cadastro invertida de propósito
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    const s = (p) => fila.itens.find((it) => it.indicador_id === p.a).situacao;
    expect(s(primeiro)).toBe('pronta');
    expect(s(segundo)).toBe('aguardando_teto_mensal');
    expect(fila.projetadoMes).toBe(140.83);
  });

  test('fila estrita: quem vem atrás também espera, mesmo cabendo', async () => {
    const a = par({ indicadorValor: 140.83, indicadoPagouEm: '2026-10-01' });
    const b = par({ indicadorValor: 140.83, indicadoPagouEm: '2026-10-02' });
    const pequeno = par({ indicadorValor: 74.17, indicadoPagouEm: '2026-10-03' });
    const c = cenario([a, b, pequeno]);
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.itens.map((it) => it.situacao)).toEqual(['pronta', 'aguardando_teto_mensal', 'aguardando_teto_mensal']);
  });

  test('concessões já gravadas no mês contam; as do mês passado e as estornadas não', async () => {
    const p = par({ indicadorValor: 74.17 });
    const base = { tipo: 'padrao', indicador_company_id: 'outra', referral_id: null, indicado_company_id: null };
    const c = cenario([p], {
      concessoes: [
        { ...base, id: 'k1', status: 'aplicada', data_concessao: '2026-10-03', valor: 169, asaas_payment_id: 'pay_x1' },
        { ...base, id: 'k2', status: 'aplicada', data_concessao: '2026-09-20', valor: 140.83, asaas_payment_id: 'pay_x2' },
        { ...base, id: 'k3', status: 'estornada', data_concessao: '2026-10-04', valor: 140.83, asaas_payment_id: 'pay_x3' },
        { ...base, id: 'k4', status: 'falhou', data_concessao: '2026-10-05', valor: 140.83, asaas_payment_id: 'pay_x4' },
      ],
    });
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.usadoMes).toBe(169);
    expect(fila.itens[0].situacao).toBe('aguardando_teto_mensal'); // 169 + 74,17 > 230

    // sem a de outubro, a de setembro, a estornada e a que falhou não ocupam nada
    c.db.estado.concessoes.splice(0, 1);
    const fila2 = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila2.usadoMes).toBe(0);
    expect(fila2.itens[0].situacao).toBe('pronta');
  });

  test('teto alto (R$ 400, parâmetro): os dois de R$ 140,83 cabem', async () => {
    const a = par({ indicadorValor: 140.83, indicadoPagouEm: '2026-10-01' });
    const b = par({ indicadorValor: 140.83, indicadoPagouEm: '2026-10-02' });
    const c = cenario([a, b]);
    const r = await rodar(['--teto-mensal', '400'], c);
    expect(r.prontas).toBe(2);
  });

  test('a trava na gravação recusa acima do teto mesmo com item montado antes', async () => {
    const p = par({ indicadorValor: 140.83 });
    const c = cenario([p]);
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    const item = fila.itens[0];
    c.db.estado.concessoes.push({ id: 'k9', tipo: 'padrao', status: 'aplicada', indicador_company_id: 'outra',
      data_concessao: HOJE, valor: 100, asaas_payment_id: 'pay_outra' });
    await expect(lib.concederUma({ db: c.db, asaas: c.asaas, item, hoje: HOJE })).rejects.toThrow(/teto do mês/);
    expect(deletes(c.asaas)).toEqual([]);
  });

  test('cobrança maior que o teto sozinha não trava a fila', async () => {
    const grande = par({ indicadorValor: 280, indicadoPagouEm: '2026-10-01' });
    const normal = par({ indicadorValor: 140.83, indicadoPagouEm: '2026-10-02' });
    const c = cenario([grande, normal]);
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.itens.map((it) => it.situacao)).toEqual(['acima_do_teto', 'pronta']);
  });

  test('3 concessões no ano para o mesmo indicador: a quarta é recusada; as de 2025 não contam', async () => {
    const p = par({ indicadorValor: 74.17 });
    const k = (id, data) => ({ id, tipo: 'padrao', status: 'aplicada', indicador_company_id: p.a, data_concessao: data,
      valor: 74.17, asaas_payment_id: 'pay_' + id, referral_id: null, indicado_company_id: null });
    const tres = cenario([p], { concessoes: [k('a', '2026-03-01'), k('b', '2026-05-01'), k('c', '2026-07-01')] });
    expect((await lib.montarFila({ db: tres.db, asaas: tres.asaas, hoje: HOJE })).itens[0].situacao).toBe('teto_anual');

    const p2 = par({ indicadorValor: 74.17 });
    const k2 = (id, data) => ({ ...k(id, data), indicador_company_id: p2.a });
    const doisEUmVelho = cenario([p2], { concessoes: [k2('d', '2025-12-01'), k2('e', '2026-05-01'), k2('f', '2026-07-01')] });
    expect((await lib.montarFila({ db: doisEUmVelho.db, asaas: doisEUmVelho.asaas, hoje: HOJE })).itens[0].situacao).toBe('pronta');
  });

  test('o mesmo indicador com duas indicações: uma por execução (seria a mesma cobrança)', async () => {
    const p = par({ indicadorValor: 74.17, indicadoPagouEm: '2026-10-01' });
    const outra = { ...p.candidato, referral_id: 'ref-outra', indicado_id: 'emp-outra', indicado_nome: 'Outra',
      indicado_cnpj: '33.333.333/0001-33', indicado_email: 'o@o.com', indicado_user_email: 'o@dono.com', indicado_user_phone: '31977776666' };
    const ev = { company_id: 'emp-outra', event: 'PAYMENT_RECEIVED', processed_at: '2026-10-03T12:00:00Z', dia: '2026-10-03',
      pagamento_id: 'pay_outra_1', referencia: 'emp-outra', pago_em: '2026-10-03', valor: 112.66 };
    const ordem = [];
    const db = fakeDb({ candidatos: [p.candidato, outra], eventos: [...p.eventos, ev], ordem });
    const asaas = fakeAsaas({ pendentes: p.pendentes, ordem });
    const fila = await lib.montarFila({ db, asaas, hoje: HOJE });
    expect(fila.itens.map((it) => it.situacao)).toEqual(['pronta', 'uma_por_execucao']);
  });
});

describe('indicador em dia', () => {
  test('PAYMENT_OVERDUE aberto há mais de 3 dias: recusa', async () => {
    const p = par({ eventosExtra: [{ event: 'PAYMENT_OVERDUE', processed_at: '2026-10-05T12:00:00Z', dia: '2026-10-05',
      pagamento_id: 'pay_atrasada', referencia: null, assinatura: 'sub_x', valor: 93.17 }] });
    const c = cenario([p]);
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.itens[0].situacao).toBe('indicador_em_atraso');
    expect(fila.itens[0].motivo).toMatch(/pay_atrasada/);
  });

  test('atraso de 3 dias ou menos não barra; atraso pago depois também não', async () => {
    const recente = par({ eventosExtra: [{ event: 'PAYMENT_OVERDUE', processed_at: '2026-10-11T12:00:00Z', dia: '2026-10-11',
      pagamento_id: 'pay_r', referencia: null, valor: 93.17 }] });
    const pago = par({ eventosExtra: [
      { event: 'PAYMENT_OVERDUE', processed_at: '2026-09-01T12:00:00Z', dia: '2026-09-01', pagamento_id: 'pay_p', referencia: null },
      { event: 'PAYMENT_RECEIVED', processed_at: '2026-09-03T12:00:00Z', dia: '2026-09-03', pagamento_id: 'pay_p', referencia: null, pago_em: '2026-09-03' },
    ] });
    const excluida = par({ eventosExtra: [
      { event: 'PAYMENT_OVERDUE', processed_at: '2026-09-01T12:00:00Z', dia: '2026-09-01', pagamento_id: 'pay_e', referencia: null },
      { event: 'PAYMENT_DELETED', processed_at: '2026-09-02T12:00:00Z', dia: '2026-09-02', pagamento_id: 'pay_e', referencia: null },
    ] });
    const c = cenario([recente, pago, excluida], {});
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE, params: { ...lib.PARAMETROS_PADRAO, tetoMensal: 1000 } });
    expect(fila.itens.map((it) => it.situacao)).toEqual(['pronta', 'pronta', 'pronta']);
  });

  test('cobrança OVERDUE na Asaas vencida há mais de 3 dias também recusa', async () => {
    const p = par();
    const c = cenario([p], { atrasadas: { [`cus_a${p.n}`]: [{ id: 'pay_v', status: 'OVERDUE', dueDate: '2026-10-01' }] } });
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.itens[0].situacao).toBe('indicador_em_atraso');
  });
});

describe('só cobrança futura e pendente', () => {
  test('cobrança que vence hoje ou já venceu não serve', async () => {
    const hoje = par({ vencimento: HOJE });
    const passada = par({ vencimento: '2026-10-01' });
    const c = cenario([hoje, passada]);
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.itens.map((it) => it.situacao)).toEqual(['sem_cobranca_futura', 'sem_cobranca_futura']);
  });

  test('conferirCobranca recusa cobrança paga, excluída, de outro cliente ou passada', () => {
    const item = { valor: 93.17, indicador_cliente: 'cus_a', indicador_assinatura: 'sub_a' };
    const ok = { id: 'pay_1', status: 'PENDING', dueDate: '2026-11-15', value: 93.17, customer: 'cus_a', subscription: 'sub_a' };
    expect(() => lib.conferirCobranca(ok, item, HOJE)).not.toThrow();
    expect(() => lib.conferirCobranca({ ...ok, status: 'RECEIVED' }, item, HOJE)).toThrow(/não está pendente/);
    expect(() => lib.conferirCobranca({ ...ok, deleted: true }, item, HOJE)).toThrow(/já foi excluída/);
    expect(() => lib.conferirCobranca({ ...ok, customer: 'cus_b' }, item, HOJE)).toThrow(/não é do indicador/);
    expect(() => lib.conferirCobranca({ ...ok, dueDate: '2026-10-10' }, item, HOJE)).toThrow(/não é futura/);
    expect(() => lib.conferirCobranca({ ...ok, subscription: 'sub_z' }, item, HOJE)).toThrow(/assinatura do indicador/);
  });
});

describe('elegibilidade da indicação', () => {
  const avaliar = (p, concessoes = []) => {
    const ev = new Map();
    for (const e of p.eventos) { if (!ev.has(e.company_id)) ev.set(e.company_id, []); ev.get(e.company_id).push(e); }
    return lib.avaliarCandidato(p.candidato, { eventosPorEmpresa: ev, concessoes, hoje: HOJE });
  };

  test('indicado sem PAYMENT_RECEIVED (só CONFIRMED, ou estornado) ainda não conta', () => {
    const p = par({ indicadoPagouEm: null });
    p.eventos.push({ company_id: p.b, event: 'PAYMENT_CONFIRMED', processed_at: '2026-10-05T12:00:00Z', dia: '2026-10-05', pagamento_id: 'pay_c', referencia: p.b });
    expect(avaliar(p).situacao).toBe('aguardando_pagamento_indicado');

    const q = par();
    q.eventos.push({ company_id: q.b, event: 'PAYMENT_REFUNDED', processed_at: '2026-10-06T12:00:00Z', dia: '2026-10-06', pagamento_id: `pay_b${q.n}_1` });
    expect(avaliar(q).situacao).toBe('aguardando_pagamento_indicado');
  });

  test('pagamento de pedido do Canal Digital ou pacote de mensagens não conta como pagamento do plano', () => {
    const p = par({ indicadoPagouEm: null });
    p.eventos.push({ company_id: p.b, event: 'PAYMENT_RECEIVED', processed_at: '2026-10-05T12:00:00Z', dia: '2026-10-05',
      pagamento_id: 'pay_pack', referencia: 'wa-pack-123', pago_em: '2026-10-05' });
    expect(avaliar(p).situacao).toBe('aguardando_pagamento_indicado');
  });

  test('antifraude: mesmo CNPJ, e-mail, telefone ou dono barram', () => {
    expect(avaliar(par({ extraIndicado: { indicado_cnpj: '11111111000199', indicador_cnpj: '11.111.111/0001-99' } })).situacao)
      .toBe('barrada_antifraude');
    expect(avaliar(par({ extraIndicado: { indicado_email: 'X@Loja.com ', indicador_user_email: 'x@loja.com' } })).motivo)
      .toBe('mesmo e-mail');
    expect(avaliar(par({ extraIndicado: { indicado_phone: '+55 (11) 98888-7777', indicador_phone: '11988887777' } })).motivo)
      .toBe('mesmo telefone');
    expect(avaliar(par({ extraIndicado: { referred_user_id: 'u-mesmo', referrer_id: 'u-mesmo' } })).motivo).toMatch(/mesmo dono/);
  });

  test('indicador em trial: espera a assinatura por 60 dias e depois a indicação vence', () => {
    expect(avaliar(par({ assinatura: false, indicadorPagou: false, indicadoPagouEm: '2026-10-01' })).situacao)
      .toBe('aguardando_assinatura_indicador');
    expect(avaliar(par({ assinatura: false, indicadorPagou: false, indicadoPagouEm: '2026-07-01' })).situacao).toBe('vencida');
  });

  test('indicador que assinou mas não pagou a primeira: espera (o mês grátis é a segunda)', () => {
    expect(avaliar(par({ indicadorPagou: false })).situacao).toBe('aguardando_primeiro_pagamento_indicador');
  });

  test('indicado que já gerou concessão (inclusive combinada) não gera outra', () => {
    const p = par();
    const viva = { id: 'k', tipo: 'combinada', status: 'aplicada', referral_id: null, indicado_company_id: p.b, valor: 140.83 };
    expect(avaliar(p, [viva]).situacao).toBe('concedida');
    expect(avaliar(p, [{ ...viva, status: 'estornada' }]).situacao).toBe('elegivel');
  });
});

describe('estorno (cobrança avulsa de mesmo valor e vencimento)', () => {
  const concedida = (extra = {}) => ({
    id: 'k1', tipo: 'padrao', status: 'aplicada', indicador_company_id: 'emp-a', data_concessao: '2026-10-10', valor: 93.17,
    asaas_payment_id: 'pay_x', cobranca_vencimento: '2026-11-15', cobranca_forma: 'PIX', asaas_customer_id: 'cus_a', ...extra,
  });

  test('dry-run só descreve', async () => {
    const c = cenario([], { concessoes: [concedida()] });
    const r = await rodar(['--estornar', 'k1'], c);
    expect(r.modo).toBe('dry-run');
    expect(c.db.escritas()).toEqual([]);
    expect(mutacoesNaAsaas(c.asaas)).toEqual([]);
  });

  test('--apply: grava estornando, cria a cobrança e liga o pay_ novo; sai do teto', async () => {
    const c = cenario([], { concessoes: [concedida()] });
    const r = await rodar(['--estornar', 'k1', '--apply'], c);
    expect(r.estornos).toBe(1);
    expect(c.ordem.indexOf('db:estornando')).toBeLessThan(c.ordem.indexOf('asaas:POST /payments'));
    const [, , corpo] = c.asaas.mock.calls.find(([m]) => m === 'POST');
    expect(corpo).toMatchObject({ customer: 'cus_a', value: 93.17, dueDate: '2026-11-15', billingType: 'PIX', externalReference: 'emp-a' });
    expect(c.db.estado.concessoes[0]).toMatchObject({ status: 'estornada', estorno_pay_id: 'pay_estorno_1' });
    expect(lib.usoDoTeto(c.db.estado.concessoes, HOJE).usadoMes).toBe(0);
  });

  test('vencimento original já passou: exige --vencimento', async () => {
    const c = cenario([], { concessoes: [concedida({ cobranca_vencimento: '2026-10-01' })] });
    await expect(rodar(['--estornar', 'k1', '--apply'], c)).rejects.toThrow(/--vencimento/);
    expect(c.db.escritas()).toEqual([]);
    const r = await rodar(['--estornar', 'k1', '--apply', '--vencimento', '2026-10-20'], c);
    expect(r.estornos).toBe(1);
  });

  test('a Asaas recusa: volta para aplicada com o erro', async () => {
    const c = cenario([], { concessoes: [concedida()], falharPost: { status: 400, message: 'Asaas error 400' } });
    const r = await rodar(['--estornar', 'k1', '--apply'], c);
    expect(r.estornos).toBe(0);
    expect(c.db.estado.concessoes[0]).toMatchObject({ status: 'aplicada', erro: 'estorno: Asaas error 400' });
  });

  test('só concessão aplicada pode ser estornada', async () => {
    const c = cenario([], { concessoes: [concedida({ status: 'estornada' })] });
    await expect(rodar(['--estornar', 'k1', '--apply'], c)).rejects.toThrow(/só 'aplicada'/);
  });
});

describe('combinada (antes de 15/10): fora do teto, um benefício por indicado', () => {
  // Fernanda já pagou a 1ª mensalidade (avulsa): a cobrança de novembro não é a primeira.
  const pagouAntes = [{ company_id: 'emp-fernanda', event: 'PAYMENT_RECEIVED', processed_at: '2026-09-10T12:00:00Z', dia: '2026-09-10',
    pagamento_id: 'pay_f_1', referencia: 'emp-fernanda', pago_em: '2026-09-10', valor: 140.83 }];
  const empresas = [
    { id: 'emp-fernanda', nome: 'Fernanda', asaas_customer_id: 'cus_f', asaas_subscription_id: 'sub_f' },
    { id: 'emp-valen', nome: 'Valen', asaas_customer_id: 'cus_v', asaas_subscription_id: null },
  ];
  const cobranca = { id: 'pay_f_nov', status: 'PENDING', dueDate: '2026-11-10', value: 140.83, customer: 'cus_f', subscription: 'sub_f', billingType: 'CREDIT_CARD' };
  const argv = ['--combinada', '--indicador', 'emp-fernanda', '--indicado', 'emp-valen', '--cobranca', 'pay_f_nov'];
  const cheio = { id: 'k0', tipo: 'padrao', status: 'aplicada', indicador_company_id: 'outra', data_concessao: HOJE, valor: 230, asaas_payment_id: 'pay_cheio' };

  test('teto do mês cheio não impede a combinada; grava tipo combinada antes de excluir', async () => {
    const ordem = [];
    const db = fakeDb({ empresas, eventos: pagouAntes, concessoes: [cheio], ordem });
    const asaas = fakeAsaas({ pendentes: { sub_f: [cobranca] }, ordem });
    const r = await rodar([...argv, '--apply'], { db, asaas });
    expect(r.concedidas).toBe(1);
    expect(ordem.indexOf('db:inserir')).toBeLessThan(ordem.indexOf('asaas:DELETE /payments/pay_f_nov'));
    expect(db.estado.concessoes[1]).toMatchObject({ tipo: 'combinada', status: 'aplicada', valor: 140.83, indicado_company_id: 'emp-valen' });
    // a combinada não entra na soma do teto
    expect(lib.usoDoTeto(db.estado.concessoes, HOJE).usadoMes).toBe(230);
  });

  test('segunda combinada para o mesmo indicado é recusada', async () => {
    const db = fakeDb({ empresas, eventos: pagouAntes, concessoes: [{ id: 'k1', tipo: 'combinada', status: 'aplicada', indicado_company_id: 'emp-valen',
      indicador_company_id: 'emp-fernanda', data_concessao: HOJE, valor: 140.83, asaas_payment_id: 'pay_antiga' }] });
    const asaas = fakeAsaas({ pendentes: { sub_f: [cobranca] } });
    const r = await rodar([...argv, '--apply'], { db, asaas });
    expect(r.resultados[0].recusada).toMatch(/já tem concessão/);
    expect(deletes(asaas)).toEqual([]);
  });

  test('sem --apply não escreve', async () => {
    const db = fakeDb({ empresas, eventos: pagouAntes });
    const asaas = fakeAsaas({ pendentes: { sub_f: [cobranca] } });
    const r = await rodar(argv, { db, asaas });
    expect(r.modo).toBe('dry-run');
    expect(db.escritas()).toEqual([]);
    expect(mutacoesNaAsaas(asaas)).toEqual([]);
  });
});

// ── revisão de 14/10: respostas ambíguas da Asaas ──────────────────────
const RAPIDO = { tempoLimiteMs: 50, esperaAposTempoMs: 0 };
const rodarRapido = (argv, c, extra = {}) => rodar(argv, c, { params: RAPIDO, ...extra });

describe('exclusão sem resposta limpa: confere a cobrança antes de decidir', () => {
  test('erro de rede mas a cobrança foi excluída: aplicada (a consulta confirma)', async () => {
    const c = cenario([par()], { asaasOpts: { delete: { erro: 'socket hang up', apagaMesmoAssim: true } } });
    const r = await rodarRapido(['--apply'], c);
    expect(r.concedidas).toBe(1);
    expect(r.resultados[0].aviso).toMatch(/consulta mostrou a cobrança excluída/);
    expect(c.db.estado.concessoes[0].status).toBe('aplicada');
  });

  test('5xx e a cobrança continua pendente: falhou', async () => {
    const c = cenario([par()], { asaasOpts: { delete: { erro: { status: 502, message: 'Bad Gateway' } } } });
    const r = await rodarRapido(['--apply'], c);
    expect(r.concedidas).toBe(0);
    expect(c.db.estado.concessoes[0]).toMatchObject({ status: 'falhou', erro: 'Bad Gateway' });
  });

  test('erro e a consulta devolve 404 (cobrança sumiu): aplicada', async () => {
    const c = cenario([par()], { asaasOpts: { delete: { erro: 'ECONNRESET', getDepois: '404' } } });
    await rodarRapido(['--apply'], c);
    expect(c.db.estado.concessoes[0].status).toBe('aplicada');
  });

  test('corpo que não é JSON ({}) e cobrança excluída: aplicada; sem excluir: falhou', async () => {
    const a = cenario([par()], { asaasOpts: { delete: { resposta: {}, apagaMesmoAssim: true } } });
    await rodarRapido(['--apply'], a);
    expect(a.db.estado.concessoes[0].status).toBe('aplicada');
    const b = cenario([par()], { asaasOpts: { delete: { resposta: {} } } });
    await rodarRapido(['--apply'], b);
    expect(b.db.estado.concessoes[0].status).toBe('falhou');
  });

  test('tempo esgotado e a exclusão chegou: aplicada', async () => {
    const c = cenario([par()], { asaasOpts: { delete: { pendura: true, apagaMesmoAssim: true } } });
    const r = await rodarRapido(['--apply'], c);
    expect(r.concedidas).toBe(1);
    expect(c.db.estado.concessoes[0].status).toBe('aplicada');
  });

  test('sem como saber: fica registrada, anota o erro e a próxima execução não concede de novo nem na cobrança seguinte', async () => {
    const p = par({ indicadorValor: 74.17, indicadoPagouEm: '2026-10-01' });
    // segunda indicação do MESMO indicador, e uma segunda cobrança futura dele
    const outra = { ...p.candidato, referral_id: 'ref-outra2', indicado_id: 'emp-outra2', indicado_nome: 'Outra',
      indicado_cnpj: '44.444.444/0001-44', indicado_email: 'o2@o.com', indicado_user_email: 'o2@dono.com', indicado_user_phone: '41977776666' };
    const ev = { company_id: 'emp-outra2', event: 'PAYMENT_RECEIVED', processed_at: '2026-10-03T12:00:00Z', dia: '2026-10-03',
      pagamento_id: 'pay_outra2_1', referencia: 'emp-outra2', pago_em: '2026-10-03', valor: 112.66 };
    const sub = p.candidato.indicador_assinatura;
    const segunda = { ...p.pendentes[sub][0], id: `pay_a${p.n}_dez`, dueDate: '2026-12-15' };
    const ordem = [];
    const db = fakeDb({ candidatos: [p.candidato, outra], eventos: [...p.eventos, ev], ordem });
    const asaas = fakeAsaas({ pendentes: { [sub]: [p.pendentes[sub][0], segunda] }, ordem, delete: { pendura: true, getDepois: 'erro' } });

    const r1 = await rodarRapido(['--apply'], { db, asaas });
    expect(r1.resultados[0]).toMatchObject({ ok: false, emConferencia: true });
    expect(db.estado.concessoes).toHaveLength(1);
    expect(db.estado.concessoes[0].status).toBe('registrada');
    expect(db.estado.concessoes[0].erro).toMatch(/Conferir no painel da Asaas/);

    const r2 = await rodarRapido(['--apply'], { db, asaas });
    expect(r2.resultados).toEqual([]);
    const fila = await lib.montarFila({ db, asaas, hoje: HOJE, params: { ...lib.PARAMETROS_PADRAO, ...RAPIDO } });
    expect(fila.itens.map((it) => it.situacao)).toEqual(['em_conferencia', 'indicador_em_conferencia']);
    expect(asaas.mock.calls.filter(([m]) => m === 'DELETE')).toHaveLength(1);
    expect(asaas.mock.calls.some(([m, cam]) => m === 'DELETE' && cam.includes('_dez'))).toBe(false);
  });

  test('comTempoLimite: rejeita marcado como tempo esgotado', async () => {
    const lento = lib.comTempoLimite(() => new Promise(() => {}), 20);
    await expect(lento('GET', '/x')).rejects.toMatchObject({ tempoEsgotado: true });
  });
});

describe('estorno sem resposta limpa: fica estornando e confere antes de recriar', () => {
  const concedida = (extra = {}) => ({
    id: 'k1', tipo: 'padrao', status: 'aplicada', indicador_company_id: 'emp-a', data_concessao: '2026-10-10', valor: 93.17,
    asaas_payment_id: 'pay_x', cobranca_vencimento: '2026-11-15', cobranca_forma: 'PIX', asaas_customer_id: 'cus_a', ...extra,
  });
  const posts = (asaas) => asaas.mock.calls.filter(([m]) => m === 'POST');

  test('POST com erro de rede que criou a cobrança: estornando; rodar de novo liga a existente sem criar outra', async () => {
    const c = cenario([], { concessoes: [concedida()], asaasOpts: { post: { erro: 'socket hang up', criaMesmoAssim: true } } });
    const r1 = await rodarRapido(['--estornar', 'k1', '--apply'], c);
    expect(r1.resultado).toMatchObject({ ok: false, emConferencia: true });
    expect(c.db.estado.concessoes[0].status).toBe('estornando');

    const r2 = await rodarRapido(['--estornar', 'k1', '--apply'], c);
    expect(r2.resultado).toMatchObject({ ok: true, reaproveitada: true, estornoPayId: 'pay_estorno_1' });
    expect(c.db.estado.concessoes[0]).toMatchObject({ status: 'estornada', estorno_pay_id: 'pay_estorno_1' });
    expect(posts(c.asaas)).toHaveLength(1);
  });

  test('tempo esgotado sem criar: estornando; rodar de novo confere (nada lá) e só então cria', async () => {
    const c = cenario([], { concessoes: [concedida()], asaasOpts: { post: { pendura: true } } });
    await rodarRapido(['--estornar', 'k1', '--apply'], c);
    expect(c.db.estado.concessoes[0].status).toBe('estornando');
    c.asaas.mockClear();
    const ordem = c.ordem;
    ordem.length = 0;
    // a Asaas voltou ao normal
    const normal = fakeAsaas({ ordem });
    const r = await rodarRapido(['--estornar', 'k1', '--apply'], { db: c.db, asaas: normal });
    expect(r.resultado).toMatchObject({ ok: true });
    expect(ordem.findIndex((o) => o.includes('externalReference'))).toBeLessThan(ordem.indexOf('asaas:POST /payments'));
    expect(c.db.estado.concessoes[0].status).toBe('estornada');
  });

  test('estornando e a Asaas não responde à conferência: recusa, nenhuma cobrança criada', async () => {
    const c = cenario([], { concessoes: [concedida({ status: 'estornando' })], asaasOpts: { busca: 'erro' } });
    await expect(rodarRapido(['--estornar', 'k1', '--apply'], c)).rejects.toThrow(/não deu para conferir/);
    expect(posts(c.asaas)).toHaveLength(0);
    expect(c.db.estado.concessoes[0].status).toBe('estornando');
  });

  test('recusa clara (4xx) volta para aplicada', async () => {
    const c = cenario([], { concessoes: [concedida()], asaasOpts: { post: { erro: { status: 422, message: 'vencimento inválido' } } } });
    const r = await rodarRapido(['--estornar', 'k1', '--apply'], c);
    expect(r.resultado).toMatchObject({ ok: false });
    expect(c.db.estado.concessoes[0].status).toBe('aplicada');
  });

  test('indicador com estorno pendente não recebe outra concessão', async () => {
    const p = par();
    const c = cenario([p], { concessoes: [concedida({ status: 'estornando', indicador_company_id: p.a, referral_id: 'ref-velha' })] });
    const fila = await lib.montarFila({ db: c.db, asaas: c.asaas, hoje: HOJE });
    expect(fila.itens[0].situacao).toBe('indicador_em_conferencia');
  });
});

describe('combinada: nunca a primeira mensalidade sem confirmação explícita', () => {
  const empresas = [
    { id: 'emp-jenny', nome: 'Jenny', asaas_customer_id: 'cus_j', asaas_subscription_id: 'sub_j' },
    { id: 'emp-luis', nome: 'Luis', asaas_customer_id: 'cus_l', asaas_subscription_id: null },
  ];
  const cobranca = { id: 'pay_j_1', status: 'PENDING', dueDate: '2026-11-10', value: 140.83, customer: 'cus_j', subscription: 'sub_j' };
  const argv = ['--combinada', '--indicador', 'emp-jenny', '--indicado', 'emp-luis', '--cobranca', 'pay_j_1'];

  test('indicador sem pagamento recebido: recusa sem gravar nem excluir', async () => {
    const db = fakeDb({ empresas });
    const asaas = fakeAsaas({ pendentes: { sub_j: [cobranca] } });
    await expect(rodarRapido([...argv, '--apply'], { db, asaas })).rejects.toThrow(/primeira mensalidade/);
    expect(db.escritas()).toEqual([]);
    expect(mutacoesNaAsaas(asaas)).toEqual([]);
  });

  test('com --confirmo-primeira-mensalidade: concede, avisa na confirmação e anota na linha', async () => {
    const db = fakeDb({ empresas });
    const asaas = fakeAsaas({ pendentes: { sub_j: [cobranca] } });
    const perguntar = jest.fn(digitaOValor);
    const r = await rodarRapido([...argv, '--confirmo-primeira-mensalidade', '--apply'], { db, asaas }, { perguntar });
    expect(r.concedidas).toBe(1);
    expect(perguntar.mock.calls[0][0]).toMatch(/PRIMEIRA mensalidade/);
    expect(db.estado.concessoes[0].observacao).toMatch(/primeira mensalidade/);
  });

  test('a flag só vale com --combinada', () => {
    expect(() => lerArgs(['--confirmo-primeira-mensalidade'])).toThrow(/só vale com --combinada/);
  });
});