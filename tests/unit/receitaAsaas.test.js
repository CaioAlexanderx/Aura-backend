// ============================================================
// services/receitaAsaas — a Asaas como fonte do MRR, e a volta para a tabela
// de preços quando ela não responde.
//
// Lojas e assinaturas inventadas. O cliente da Asaas é um jest.fn que
// responde por caminho; o banco é o mock global (tests/jest.setup.js).
// ============================================================
'use strict';

jest.mock('../../src/services/asaasClient', () => ({ asaas: jest.fn() }));

const db = require('../../src/config/database');
const asaasClient = require('../../src/services/asaasClient');
const { fonteAsaas, contratoDaAssinatura } = require('../../src/services/receitaAsaas');
const { listarAssinaturasAtivas, proximoVencimento } = require('../../src/services/asaasAssinaturas');
const { calcularMrr } = require('../../src/services/receita');
const blocoReceita = require('../../src/services/painelBlocos/receita');

const id = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;

const sub = (n, extra) => ({
  id: `sub_${n}`, customer: `cus_${n}`, value: 169, cycle: 'MONTHLY', status: 'ACTIVE',
  nextDueDate: '2026-11-05', description: 'Aura Negócio', externalReference: null, ...extra,
});
const empresa = (n, extra) => ({
  company_id: id(n), nome: `Loja ${n}`, telefone: null, plan: 'negocio', ciclo: 'monthly', status: 'active',
  asaas_subscription_id: `sub_${n}`, asaas_customer_id: `cus_${n}`, is_primary: true, interna: false, ...extra,
});
// linha de fonteCompanies (o cadastro)
const pagante = (n, extra) => ({
  company_id: id(n), nome: `Loja ${n}`, telefone: null, plan: 'negocio', ciclo: 'monthly',
  valor_contrato: 169, meses_contrato: 1, addons_mensal: 0, tem_cobranca: true, ...extra,
});

// Asaas que devolve as assinaturas em páginas de `porPagina`.
function asaasCom(subs, porPagina = 100) {
  return jest.fn(async (metodo, caminho) => {
    const offset = Number(/offset=(\d+)/.exec(caminho)[1]);
    const limit = Number(/limit=(\d+)/.exec(caminho)[1]);
    expect(limit).toBe(porPagina);
    const data = subs.slice(offset, offset + limit);
    return { data, hasMore: offset + limit < subs.length, totalCount: subs.length };
  });
}

const comEmpresas = (empresas) => ({ query: jest.fn(async () => ({ rows: empresas })) });

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  db.query.mockReset();
  asaasClient.asaas.mockReset();
  delete process.env.ASAAS_API_KEY;
  jest.restoreAllMocks();
});

describe('listarAssinaturasAtivas', () => {
  test('percorre todas as páginas e pede só as ativas', async () => {
    const subs = [1, 2, 3, 4, 5].map((n) => sub(n));
    const asaas = asaasCom(subs, 2);
    const r = await listarAssinaturasAtivas(asaas, { porPagina: 2 });
    expect(r.map((s) => s.id)).toEqual(['sub_1', 'sub_2', 'sub_3', 'sub_4', 'sub_5']);
    expect(asaas.mock.calls.map((c) => c[1])).toEqual([
      '/subscriptions?status=ACTIVE&limit=2&offset=0',
      '/subscriptions?status=ACTIVE&limit=2&offset=2',
      '/subscriptions?status=ACTIVE&limit=2&offset=4',
    ]);
  });

  test('página que falha derruba a leitura inteira (meia lista seria MRR errado)', async () => {
    const asaas = jest.fn()
      .mockResolvedValueOnce({ data: [sub(1)], hasMore: true })
      .mockRejectedValueOnce(new Error('Asaas error 500'));
    await expect(listarAssinaturasAtivas(asaas, { porPagina: 1 })).rejects.toThrow('Asaas error 500');
  });

  test('assinatura apagada não entra', async () => {
    const asaas = asaasCom([sub(1), sub(2, { deleted: true })]);
    expect((await listarAssinaturasAtivas(asaas)).map((s) => s.id)).toEqual(['sub_1']);
  });
});

describe('proximoVencimento', () => {
  const asaasDe = (assinatura, cobrancas) => jest.fn(async (m, caminho) => {
    const r = caminho.includes('/payments') ? cobrancas : assinatura;
    if (r instanceof Error) throw r;
    return r;
  });

  test('sem cobrança pendente vale o nextDueDate da assinatura', async () => {
    const r = await proximoVencimento(asaasDe({ id: 'sub_1', nextDueDate: '2026-11-05' }, { data: [] }), 'sub_1');
    expect(r).toMatchObject({ data: '2026-11-05', origem: 'assinatura' });
  });

  test('com pendente mais próxima, vale a pendente (vencida e paga não contam)', async () => {
    const r = await proximoVencimento(asaasDe({ id: 'sub_1', nextDueDate: '2026-12-05' }, { data: [
      { status: 'OVERDUE', dueDate: '2026-09-05' },
      { status: 'RECEIVED', dueDate: '2026-10-05' },
      { status: 'PENDING', dueDate: '2026-11-05' },
    ] }), 'sub_1');
    expect(r).toMatchObject({ data: '2026-11-05', origem: 'cobranca_pendente' });
  });

  test('lista de cobranças fora do ar: ainda vale o nextDueDate', async () => {
    const r = await proximoVencimento(asaasDe({ id: 'sub_1', nextDueDate: '2026-11-05' }, new Error('timeout')), 'sub_1');
    expect(r.data).toBe('2026-11-05');
  });

  test('assinatura fora do ar, sem id ou sem data: null, nunca lança', async () => {
    expect(await proximoVencimento(asaasDe(new Error('Asaas error 503')), 'sub_1')).toBeNull();
    expect(await proximoVencimento(asaasDe({ id: 'sub_1' }, { data: [] }), 'sub_1')).toBeNull();
    expect(await proximoVencimento(asaasDe({ id: 'sub_1', nextDueDate: '15/11/2026' }, { data: [] }), 'sub_1')).toBeNull();
    expect(await proximoVencimento(jest.fn(), null)).toBeNull();
  });
});

describe('contratoDaAssinatura', () => {
  test('MONTHLY vale um mês; YEARLY vale doze', () => {
    expect(contratoDaAssinatura({ value: 169, cycle: 'MONTHLY' }, 'monthly'))
      .toEqual({ ciclo: 'monthly', valor_contrato: 169, meses_contrato: 1 });
    expect(contratoDaAssinatura({ value: 1689.96, cycle: 'YEARLY' }, 'annual'))
      .toEqual({ ciclo: 'annual', valor_contrato: 1689.96, meses_contrato: 12 });
  });

  test('plano anual cobrado em 12 parcelas (MONTHLY na Asaas): contrato de 12 × a parcela', () => {
    expect(contratoDaAssinatura({ value: 140.83, cycle: 'MONTHLY' }, 'annual'))
      .toEqual({ ciclo: 'annual', valor_contrato: 1689.96, meses_contrato: 12 });
  });
});

describe('fonteAsaas', () => {
  test('mesmo formato de fonteCompanies, com o valor que a Asaas cobra', async () => {
    const asaas = asaasCom([sub(1, { value: 150 })]);
    const banco = comEmpresas([empresa(1)]);
    const r = await fonteAsaas({ db: banco, asaas, cadastro: [pagante(1)] });
    expect(r.assinaturas).toEqual([{
      company_id: id(1), nome: 'Loja 1', telefone: null, plan: 'negocio', ciclo: 'monthly',
      valor_contrato: 150, meses_contrato: 1, addons_mensal: 0, tem_cobranca: true,
      asaas_subscription_id: 'sub_1',
    }]);
    // a busca das empresas leva assinaturas, clientes e referências
    expect(banco.query.mock.calls[0][1]).toEqual([['sub_1'], ['cus_1'], []]);
  });

  test('YEARLY entra no MRR dividido por 12', async () => {
    const asaas = asaasCom([sub(1), sub(2, { value: 1200, cycle: 'YEARLY' })]);
    const banco = comEmpresas([empresa(1), empresa(2, { ciclo: 'annual' })]);
    process.env.ASAAS_API_KEY = 'chave-de-teste';
    const r = await fonteAsaas({ db: banco, asaas, cadastro: [pagante(1), pagante(2)] });
    expect(r.assinaturas[1]).toMatchObject({ ciclo: 'annual', valor_contrato: 1200, meses_contrato: 12 });
    const mrr = await calcularMrr({ fonte: async () => r });
    expect(mrr.mrr_total).toBe(269); // 169 + 1200 ÷ 12
    expect(mrr.por_plano.negocio).toMatchObject({ mensais: 1, anuais: 1 });
  });

  test('assinatura sem empresa vai para a lista "sem empresa", fora do MRR', async () => {
    const asaas = asaasCom([sub(1), sub(7, { value: 140.83, description: 'Aura Negócio (Anual)' })]);
    const r = await fonteAsaas({ db: comEmpresas([empresa(1)]), asaas, cadastro: [pagante(1)] });
    expect(r.assinaturas.map((a) => a.company_id)).toEqual([id(1)]);
    expect(r.sem_empresa).toEqual([{
      asaas_subscription_id: 'sub_7', asaas_customer_id: 'cus_7', descricao: 'Aura Negócio (Anual)',
      ciclo_asaas: 'MONTHLY', valor: 140.83, mrr: 140.83, proximo_vencimento: '2026-11-05',
    }]);
  });

  test('acha a empresa pela assinatura, pela referência e pelo cliente, nessa ordem', async () => {
    const asaas = asaasCom([
      sub(1),
      sub(8, { customer: 'cus_x', externalReference: id(2).toUpperCase() }),
      sub(9, { customer: 'cus_3' }),
    ]);
    const banco = comEmpresas([
      empresa(1),
      empresa(2, { asaas_subscription_id: null, asaas_customer_id: null }),
      empresa(3, { asaas_subscription_id: null }),
    ]);
    const r = await fonteAsaas({ db: banco, asaas, cadastro: [] });
    expect(r.assinaturas.map((a) => [a.asaas_subscription_id, a.company_id])).toEqual([
      ['sub_1', id(1)], ['sub_8', id(2)], ['sub_9', id(3)],
    ]);
    expect(banco.query.mock.calls[0][1][2]).toEqual([id(2).toUpperCase()]);
  });

  test('assinatura de loja que não é pagante (ou interna) fica fora do MRR, com o motivo', async () => {
    const asaas = asaasCom([sub(1), sub(2), sub(3)]);
    const banco = comEmpresas([empresa(1), empresa(2, { status: 'trial' }), empresa(3, { interna: true })]);
    const r = await fonteAsaas({ db: banco, asaas, cadastro: [pagante(1)] });
    expect(r.assinaturas).toHaveLength(1);
    expect(r.fora_do_mrr.map((f) => [f.nome, f.motivo, f.mrr])).toEqual([
      ['Loja 2', 'loja trial', 169], ['Loja 3', 'conta interna', 169],
    ]);
  });

  test('pagante do cadastro sem assinatura ativa continua pagante, sem cobrança registrada', async () => {
    const asaas = asaasCom([sub(1)]);
    const r = await fonteAsaas({ db: comEmpresas([empresa(1)]), asaas, cadastro: [pagante(1), pagante(4, { plan: 'expansao', valor_contrato: 269 })] });
    expect(r.assinaturas[1]).toMatchObject({ company_id: id(4), tem_cobranca: false, valor_contrato: 269 });
    const mrr = await calcularMrr({ fonte: async () => r });
    expect(mrr.pagantes).toBe(2);
    expect(mrr.mrr_total).toBe(169);
    expect(mrr.sem_cobranca.mrr_potencial).toBe(269);
  });

  test('duas assinaturas ativas da mesma loja: as duas somam e a loja é apontada', async () => {
    const asaas = asaasCom([sub(1), sub(5, { customer: 'cus_1', value: 89 })]);
    const r = await fonteAsaas({ db: comEmpresas([empresa(1)]), asaas, cadastro: [pagante(1)] });
    expect(r.assinaturas.map((a) => a.valor_contrato)).toEqual([169, 89]);
    expect(r.duplicadas.map((d) => d.asaas_subscription_id)).toEqual(['sub_1', 'sub_5']);
  });

  test('cliente repetido no grupo multi-CNPJ: vale a empresa principal', async () => {
    const asaas = asaasCom([sub(9, { customer: 'cus_grupo' })]);
    const banco = comEmpresas([
      empresa(2, { asaas_subscription_id: null, asaas_customer_id: 'cus_grupo', is_primary: false }),
      empresa(1, { asaas_subscription_id: null, asaas_customer_id: 'cus_grupo', is_primary: true }),
    ]);
    const r = await fonteAsaas({ db: banco, asaas, cadastro: [] });
    expect(r.assinaturas[0].company_id).toBe(id(1));
  });
});

// calcularMrr sem `fonte`: Asaas quando há chave, tabela quando ela falha.
describe('calcularMrr — Asaas com volta para a tabela', () => {
  const cadastroNoBanco = () => db.query.mockImplementation(async (sql) => {
    if (sql.includes('extra_seats_granted')) return { rows: [] };
    if (sql.includes('c.asaas_subscription_id = ANY')) return { rows: [empresa(1), empresa(2, { ciclo: 'annual' })] };
    return { rows: [
      { company_id: id(1), nome: 'Loja 1', telefone: null, plan: 'negocio', ciclo: 'monthly', tem_cobranca: true },
      { company_id: id(2), nome: 'Loja 2', telefone: null, plan: 'negocio', ciclo: 'annual', tem_cobranca: true },
    ] };
  });

  // O cliente da Asaas que calcularMrr usa quando ninguém passa outro.
  function comAsaas(impl) {
    asaasClient.asaas.mockImplementation(impl);
    return calcularMrr;
  }

  test('com ASAAS_API_KEY usa a Asaas e mostra as duas somas lado a lado', async () => {
    process.env.ASAAS_API_KEY = 'chave-de-teste';
    cadastroNoBanco();
    // a Asaas cobra 150 da loja 1 e 100 (parcela do anual) da loja 2
    const calcular = comAsaas(async () => ({
      data: [sub(1, { value: 150 }), sub(2, { value: 100 })], hasMore: false,
    }));
    const r = await calcular({ db });
    expect(r.fonte).toBe('asaas');
    expect(r.aviso).toBeNull();
    expect(r.mrr_total).toBe(250);
    // tabela: 169 + 140,83
    expect(r.comparativo).toEqual({ asaas: 250, tabela: 309.83, tabela_todos_pagantes: 309.83 });
    expect(r.sem_empresa).toEqual([]);
  });

  test('a Asaas falha: cai para a tabela de preços e avisa', async () => {
    process.env.ASAAS_API_KEY = 'chave-de-teste';
    cadastroNoBanco();
    const calcular = comAsaas(async () => { throw new Error('Asaas error 503'); });
    const r = await calcular({ db });
    expect(r.fonte).toBe('companies');
    expect(r.mrr_total).toBe(309.83);
    expect(r.aviso).toContain('A Asaas não respondeu (Asaas error 503)');
    expect(r.comparativo).toEqual({ asaas: null, tabela: 309.83, tabela_todos_pagantes: 309.83 });
  });

  test('sem ASAAS_API_KEY nem tenta: tabela de preços, sem aviso', async () => {
    cadastroNoBanco();
    const r = await calcularMrr({ db });
    expect(r.fonte).toBe('companies');
    expect(r.aviso).toBeNull();
    expect(asaasClient.asaas).not.toHaveBeenCalled();
  });
});

describe('bloco Receita — fonte usada e dupla checagem', () => {
  const banco = { query: jest.fn(async () => ({ rows: [] })) };
  const empresas = { lista: [], porId: new Map(), pagantes: [] };

  test('mostra a fonte, as duas somas e as assinaturas sem empresa', async () => {
    const mrr = await calcularMrr({ fonte: async () => [pagante(1, { valor_contrato: 150 })] });
    const bloco = await blocoReceita.calcular({
      hoje: '2026-10-13', db: banco, empresas,
      mrr: {
        ...mrr,
        fonte: 'asaas',
        fonte_rotulo: 'Asaas (assinaturas ativas, anual ÷ 12)',
        aviso: null,
        comparativo: { asaas: 150, tabela: 169, tabela_todos_pagantes: 438 },
        sem_empresa: [{ asaas_subscription_id: 'sub_7', asaas_customer_id: 'cus_7', descricao: 'Aura Negócio', mrr: 140.83, proximo_vencimento: '2026-11-12' }],
        fora_do_mrr: [],
        duplicadas: [],
      },
    });
    expect(bloco.valor).toBe(150);
    expect(bloco.fonte).toBe('Asaas (assinaturas ativas, anual ÷ 12) · webhook_logs (Asaas)');
    expect(bloco.detalhe.indicadores.slice(0, 2)).toEqual([
      { rotulo: 'MRR pela Asaas', valor: 150, nota: 'fonte usada' },
      { rotulo: 'MRR pela tabela', valor: 169, nota: 'para conferir' },
    ]);
    const semEmpresa = bloco.detalhe.listas.find((l) => l.titulo === 'Assinaturas na Asaas sem empresa');
    expect(semEmpresa.linhas).toEqual([{
      assinatura: 'sub_7', cliente_asaas: 'cus_7', descricao: 'Aura Negócio', mrr: 140.83, proximo_vencimento: '2026-11-12',
    }]);
    expect(bloco.detalhe.insight).toContain('Asaas cobra R$ 150,00 por mês; a tabela de preços diria R$ 169,00');
    expect(bloco.detalhe.insight).toContain('1 assinatura ativa na Asaas sem empresa (R$ 140,83 fora do MRR)');
  });

  test('quando a Asaas falhou, o bloco diz que o número é da tabela', async () => {
    const mrr = await calcularMrr({ fonte: async () => [pagante(1)] });
    const bloco = await blocoReceita.calcular({
      hoje: '2026-10-13', db: banco, empresas,
      mrr: {
        ...mrr, fonte: 'companies', fonte_rotulo: 'companies + tabela de preços (anual ÷ 12)',
        aviso: 'A Asaas não respondeu (Asaas error 503): MRR calculado pela tabela de preços.',
        comparativo: { asaas: null, tabela: 169, tabela_todos_pagantes: 169 },
      },
    });
    expect(bloco.detalhe.indicadores[0]).toEqual({ rotulo: 'MRR pela Asaas', valor: null, nota: 'Asaas não respondeu' });
    expect(bloco.detalhe.indicadores[1]).toEqual({ rotulo: 'MRR pela tabela', valor: 169, nota: 'fonte usada' });
    expect(bloco.detalhe.insight).toContain('A Asaas não respondeu (Asaas error 503)');
  });

  test('recebido no mês: um por cobrança, com o pagamento sem loja marcado', async () => {
    const recebidos = [
      { id: 'w2', company_id: null, event: 'PAYMENT_RECEIVED', processed_at: '2026-10-12T13:10:00.000Z', mes_recebido: '2026-10', valor: '140.83', pagamento_id: 'pay_2', cliente_asaas: 'cus_orfao', vencimento: '2026-10-12' },
      { id: 'w1', company_id: id(1), event: 'PAYMENT_CONFIRMED', processed_at: '2026-10-05T09:00:00.000Z', mes_recebido: '2026-10', valor: '169.00', pagamento_id: 'pay_1', cliente_asaas: 'cus_1', vencimento: '2026-10-05' },
      { id: 'w0', company_id: id(1), event: 'PAYMENT_RECEIVED', processed_at: '2026-09-05T09:00:00.000Z', mes_recebido: '2026-09', valor: '169.00', pagamento_id: 'pay_0', cliente_asaas: 'cus_1', vencimento: '2026-09-05' },
    ];
    const comRecebidos = { query: jest.fn(async (sql) => ({ rows: sql.includes('AS mes_recebido') ? recebidos : [] })) };
    const loja = { company_id: id(1), nome: 'Loja 1', telefone: '11999990001' };
    const bloco = await blocoReceita.calcular({
      hoje: '2026-10-13', db: comRecebidos,
      empresas: { lista: [loja], porId: new Map([[id(1), loja]]), pagantes: [loja] },
      mrr: await calcularMrr({ fonte: async () => [pagante(1)] }),
    });

    const sql = comRecebidos.query.mock.calls.map((c) => c[0]).find((s) => s.includes('AS mes_recebido'));
    expect(sql).toContain("event IN ('PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED')");
    // CONFIRMED seguido de RECEIVED da mesma cobrança conta uma vez
    expect(sql).toContain("SELECT DISTINCT ON (COALESCE(COALESCE(payload->'payment', payload)->>'id', id::text))");

    expect(bloco.resumo).toBe('Recebido em out: R$ 309,83');
    const ind = (rotulo) => bloco.detalhe.indicadores.find((i) => i.rotulo === rotulo);
    expect(ind('Recebido · Out')).toEqual({ rotulo: 'Recebido · Out', valor: 309.83, nota: '2 pagamentos · 1 sem loja (R$ 140,83)' });
    expect(ind('Recebido · Set')).toEqual({ rotulo: 'Recebido · Set', valor: 169, nota: '1 pagamento' });
    const doMes = bloco.detalhe.listas.find((l) => l.titulo === 'Recebido em out').linhas;
    expect(doMes.map((p) => [p.nome, p.valor, p.sem_loja, p.situacao])).toEqual([
      ['Sem loja vinculada', 140.83, true, 'Sem loja'],
      ['Loja 1', 169, false, 'Vinculado'],
    ]);
    expect(bloco.detalhe.insight).toContain('1 pagamento sem loja vinculada desde set');
  });
});
