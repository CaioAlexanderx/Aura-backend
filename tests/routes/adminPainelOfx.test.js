// ============================================================
// /admin/painel/ofx — extrato OFX da conta da Aura × repasses da Asaas.
//
// pg mockado por um banco em memória (tests/helpers/fakeExtratosDb.js);
// o OFX é tests/fixtures/ofx/extrato-aura-2026-10.ofx — o mesmo do PR.
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const router = require('../../src/routes/adminPainelOfx');
const fake = require('../helpers/fakeExtratosDb');

const OFX = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ofx', 'extrato-aura-2026-10.ofx'), 'utf8');
const staff = jwt.sign({ id: fake.USER, role: 'admin' }, 'aura-test-secret-2026');
const cliente = jwt.sign({ id: fake.USER, role: 'client', company: 'aaaaaaaa-0000-4000-8000-000000000002' }, 'aura-test-secret-2026');

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/admin/painel/ofx', router);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const api = (metodo, url, token = staff) => request(makeApp())[metodo]('/admin/painel/ofx' + url).set('Authorization', 'Bearer ' + token);

// Pagamentos que a Asaas recebeu em outubro (webhook_logs, um por cobrança).
const PAGAMENTOS = [
  fake.pagamento('pay_a', '2026-10-01', 140.83),
  fake.pagamento('pay_b', '2026-10-05', 169),
  fake.pagamento('pay_c', '2026-10-10', 100, { liquido: '98.01' }),
  fake.pagamento('pay_d', '2026-10-01', 74.17),
];

let banco;
let client;

function ligar(estadoInicial = { pagamentos: PAGAMENTOS }) {
  banco = fake.criar(estadoInicial);
  db.query.mockImplementation(banco.query);
  client = { query: jest.fn(banco.query), release: jest.fn() };
  db.connect.mockImplementation(async () => client);
}

beforeAll(() => {
  jest.useFakeTimers({ now: fake.AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
});
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  ligar();
});
afterEach(() => { db.query.mockReset(); db.connect.mockReset(); jest.restoreAllMocks(); });
afterAll(() => jest.useRealTimers());

const importar = (corpo = { ofx_content: OFX, mes: '2026-10', nome_arquivo: 'extrato-outubro.ofx' }) => api('post', '/extratos').send(corpo);
const lancamentoPorFitid = (fitid) => banco.estado.lancamentos.find((l) => l.fitid === fitid);

describe('acesso', () => {
  test('sem token → 401; cliente comum → 403; nada é consultado nem gravado', async () => {
    const rotas = [
      ['post', '/extratos'], ['get', '/extratos'], ['get', '/extratos/1'],
      ['post', '/extratos/1/lancamentos/1/conciliar'], ['post', '/extratos/1/lancamentos/1/ignorar'],
      ['post', '/extratos/1/lancamentos/1/reabrir'], ['delete', '/extratos/1'],
    ];
    for (const [metodo, url] of rotas) {
      expect((await request(makeApp())[metodo]('/admin/painel/ofx' + url)).status).toBe(401);
      expect((await api(metodo, url, cliente)).status).toBe(403);
    }
    expect(db.query).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();
  });
});

describe('POST /extratos — importa e concilia', () => {
  test('grava o extrato, as linhas e já casa com a Asaas (exato, com taxa, fora da janela pendente)', async () => {
    const res = await importar();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ok: true, duplicado: false, importados: 7, duplicados: 0,
      creditos: 6, conciliados: 3, com_taxa: 1, pendentes: 3,
      extrato: { mes: '2026-10', nome_arquivo: 'extrato-outubro.ofx', total_creditos: 701.01, linhas: 7, importado_por: fake.USER },
    });

    const por = (f) => { const l = lancamentoPorFitid(f); return [l.status, l.conciliado_com, l.com_taxa]; };
    expect(por('202610020001')).toEqual(['conciliado', 'pay_a', false]);
    expect(por('202610070001')).toEqual(['conciliado', 'pay_b', false]);
    expect(por('202610080001')).toEqual(['pendente', null, false]); // pay_b só casa uma vez
    expect(por('202610120001')).toEqual(['conciliado', 'pay_c', true]); // 98,01 = líquido
    expect(por('202610140001')).toEqual(['ignorado', null, false]); // débito
    expect(por('202610150001')).toEqual(['pendente', null, false]); // sem pagamento
    expect(por('202610200001')).toEqual(['pendente', null, false]); // 19 dias depois de pay_d
  });

  test('tudo numa transação, com trava, e a conexão é devolvida', async () => {
    await importar();
    const sqls = client.query.mock.calls.map(([s]) => s.replace(/\s+/g, ' ').trim());
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls).toContain('SELECT pg_advisory_xact_lock(373)');
    expect(sqls[sqls.length - 1]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('importar o mesmo arquivo de novo não duplica: 200, duplicado e nada novo gravado', async () => {
    await importar();
    const linhas = banco.estado.lancamentos.length;
    const res = await importar();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, duplicado: true, importados: 0, duplicados: 7, conciliados: 0 });
    expect(res.body.extrato_id).toBe(banco.estado.extratos[0].id);
    expect(banco.estado.extratos).toHaveLength(1);
    expect(banco.estado.lancamentos).toHaveLength(linhas);
    const sqls = client.query.mock.calls.map(([s]) => s.replace(/\s+/g, ' ').trim());
    expect(sqls[sqls.length - 1]).toBe('ROLLBACK');
  });

  test('arquivo que repete parte das linhas: só as novas entram', async () => {
    await importar();
    const maisUma = OFX.replace('</BANKTRANLIST>', `<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20261029120000[-3:BRT]
<TRNAMT>33.00
<FITID>202610290001
<MEMO>PIX RECEBIDO
</STMTTRN>
</BANKTRANLIST>`);
    const res = await importar({ ofx_content: maisUma, mes: '2026-10' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ importados: 1, duplicados: 7, creditos: 1, conciliados: 0, pendentes: 1 });
    expect(banco.estado.extratos).toHaveLength(2);
    expect(banco.estado.lancamentos.filter((l) => l.fitid === '202610020001')).toHaveLength(1);
  });

  test('o pagamento que casou no primeiro arquivo não casa de novo no segundo', async () => {
    await importar();
    const outroBanco = OFX.replace(/FITID>2026/g, 'FITID>9026'); // mesmas linhas, outros FITIDs
    const res = await importar({ ofx_content: outroBanco, mes: '2026-10' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ importados: 7, conciliados: 0, pendentes: 6 });
  });

  test('sem mes informado, usa o mês com mais lançamentos', async () => {
    const res = await importar({ ofx_content: OFX });
    expect(res.status).toBe(201);
    expect(res.body.extrato.mes).toBe('2026-10');
  });

  test('OFX cru em windows-1252 (Content-Type application/x-ofx) mantém os acentos', async () => {
    const corpo = Buffer.from(OFX.replace('PIX RECEBIDO LOJA EXEMPLO', 'PIX RECEBIDO JOSÉ'), 'latin1');
    const res = await request(makeApp())
      .post('/admin/painel/ofx/extratos?mes=2026-10&nome_arquivo=out.ofx')
      .set('Authorization', 'Bearer ' + staff)
      .set('Content-Type', 'application/x-ofx')
      .send(corpo);
    expect(res.status).toBe(201);
    expect(res.body.extrato).toMatchObject({ mes: '2026-10', nome_arquivo: 'out.ofx' });
    expect(lancamentoPorFitid('202610080001').descricao).toBe('PIX RECEBIDO JOSÉ');
  });

  test.each([
    ['sem conteúdo', { mes: '2026-10' }, 400],
    ['conteúdo vazio', { ofx_content: '   ', mes: '2026-10' }, 400],
    ['mês fora do formato', { ofx_content: OFX, mes: 'outubro' }, 400],
    ['mês 13', { ofx_content: OFX, mes: '2026-13' }, 400],
    ['texto que não é OFX', { ofx_content: 'isto não é um extrato', mes: '2026-10' }, 422],
  ])('%s → erro e nada gravado', async (_nome, corpo, status) => {
    const res = await importar(corpo);
    expect(res.status).toBe(status);
    expect(banco.estado.extratos).toHaveLength(0);
    expect(db.connect).not.toHaveBeenCalled();
  });

  test('erro no meio da gravação: ROLLBACK, conexão devolvida e o erro sobe', async () => {
    client.query.mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO aura_extrato_lancamentos')) throw new Error('boom');
      return banco.query(sql, params);
    });
    const res = await importar();
    expect(res.status).toBe(500);
    const sqls = client.query.mock.calls.map(([s]) => s.replace(/\s+/g, ' ').trim());
    expect(sqls).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('migration 373 ainda não aplicada → 503 com a explicação', async () => {
    client.query.mockImplementation(async (sql, params) => {
      if (sql.includes('aura_extrato_lancamentos')) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      return banco.query(sql, params);
    });
    const res = await importar();
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/migration 373/);
  });
});

describe('GET /extratos', () => {
  test('Asaas × banco × diferença por mês, do mais novo ao mais antigo; "sem extrato" onde não há', async () => {
    await importar();
    const res = await api('get', '/extratos?meses=3');
    expect(res.status).toBe(200);
    expect(res.body.dia).toBe('2026-10-13');
    expect(res.body.meses.map((m) => m.mes)).toEqual(['2026-10', '2026-09', '2026-08']);
    expect(res.body.meses[0]).toMatchObject({
      rotulo: 'Out', asaas: 484, pagamentos: 4, banco: 701.01, diferenca: 217.01, status: 'pendências',
      conciliado: { n: 3, valor: 407.84 }, pendentes: { n: 3, valor: 293.17 }, sem_credito: { n: 1, valor: 74.17 },
    });
    expect(res.body.meses[0].extratos).toHaveLength(1);
    expect(res.body.meses[1]).toMatchObject({ status: 'sem extrato', banco: null, diferenca: null, asaas: 0 });
  });

  test('sem extrato nenhum, todos os meses dizem "sem extrato" e mostram a Asaas', async () => {
    const res = await api('get', '/extratos');
    expect(res.status).toBe(200);
    expect(res.body.meses).toHaveLength(6);
    expect(res.body.meses.every((m) => m.status === 'sem extrato')).toBe(true);
    expect(res.body.meses[0].asaas).toBe(484);
  });

  test.each(['0', '25', 'abc'])('meses=%s → 400', async (v) => {
    expect((await api('get', `/extratos?meses=${v}`)).status).toBe(400);
  });
});

describe('GET /extratos/:id', () => {
  test('lançamentos com status, resumo e os pagamentos da Asaas ainda sem crédito', async () => {
    const criado = await importar();
    const id = criado.body.extrato.id;
    const res = await api('get', `/extratos/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.extrato).toMatchObject({ id, mes: '2026-10', linhas: 7 });
    expect(res.body.lancamentos).toHaveLength(7);
    expect(res.body.lancamentos[0]).toMatchObject({
      data: '2026-10-02', valor: 140.83, tipo: 'credito', status: 'conciliado', conciliado_com: 'pay_a', com_taxa: false, fitid: '202610020001',
    });
    expect(res.body.resumo).toEqual({
      creditos: 6, total_creditos: 701.01,
      conciliados: { n: 3, valor: 407.84, com_taxa: 1 },
      pendentes: { n: 3, valor: 293.17 },
      ignorados: { n: 0, valor: 0 },
      debitos: 1,
    });
    expect(res.body.pagamentos_disponiveis).toEqual([
      { pagamento_id: 'pay_d', log_id: 'log_pay_d', company_id: null, valor: 74.17, liquido: null, data: '2026-10-01' },
    ]);
  });

  test('id inexistente → 404; id fora do formato → 400', async () => {
    expect((await api('get', '/extratos/999')).status).toBe(404);
    expect((await api('get', '/extratos/abc')).status).toBe(400);
  });
});

describe('conciliação manual', () => {
  let id;
  let pendente50; // PIX sem pagamento
  let pendente74; // 19 dias depois de pay_d
  beforeEach(async () => {
    id = (await importar()).body.extrato.id;
    pendente50 = lancamentoPorFitid('202610150001').id;
    pendente74 = lancamentoPorFitid('202610200001').id;
  });

  test('conciliar liga o crédito ao pagamento escolhido e pode marcar taxa', async () => {
    const res = await api('post', `/extratos/${id}/lancamentos/${pendente74}/conciliar`).send({ pagamento_id: 'pay_d' });
    expect(res.status).toBe(200);
    expect(res.body.lancamento).toMatchObject({ id: pendente74, status: 'conciliado', conciliado_com: 'pay_d', com_taxa: false });
    expect(res.body.pagamento).toEqual({ pagamento_id: 'pay_d', valor: 74.17, data: '2026-10-01' });
  });

  test('aceita o id do webhook_log e grava a chave canônica do pagamento', async () => {
    const res = await api('post', `/extratos/${id}/lancamentos/${pendente74}/conciliar`).send({ pagamento_id: 'log_pay_d' });
    expect(res.status).toBe(200);
    expect(res.body.lancamento.conciliado_com).toBe('pay_d');
  });

  test('crédito menor que o cobrado vira "com taxa"', async () => {
    const res = await api('post', `/extratos/${id}/lancamentos/${pendente50}/conciliar`).send({ pagamento_id: 'pay_d' });
    expect(res.status).toBe(200);
    expect(res.body.lancamento).toMatchObject({ status: 'conciliado', com_taxa: true });
  });

  test('pagamento que já casou com outro crédito → 409 e nada muda', async () => {
    const res = await api('post', `/extratos/${id}/lancamentos/${pendente50}/conciliar`).send({ pagamento_id: 'pay_a' });
    expect(res.status).toBe(409);
    expect(lancamentoPorFitid('202610150001').status).toBe('pendente');
  });

  test('pagamento que a Asaas nunca recebeu → 404', async () => {
    const res = await api('post', `/extratos/${id}/lancamentos/${pendente50}/conciliar`).send({ pagamento_id: 'pay_zzz' });
    expect(res.status).toBe(404);
  });

  test('sem pagamento_id → 400; débito → 400; lançamento de outro extrato → 404', async () => {
    expect((await api('post', `/extratos/${id}/lancamentos/${pendente50}/conciliar`).send({})).status).toBe(400);
    const debito = lancamentoPorFitid('202610140001').id;
    expect((await api('post', `/extratos/${id}/lancamentos/${debito}/conciliar`).send({ pagamento_id: 'pay_d' })).status).toBe(400);
    expect((await api('post', `/extratos/999/lancamentos/${pendente50}/conciliar`).send({ pagamento_id: 'pay_d' })).status).toBe(404);
  });

  test('ignorar tira o crédito das pendências; reabrir devolve; conciliado volta a pendente', async () => {
    let res = await api('post', `/extratos/${id}/lancamentos/${pendente50}/ignorar`);
    expect(res.status).toBe(200);
    expect(res.body.lancamento).toMatchObject({ status: 'ignorado', conciliado_com: null });

    res = await api('post', `/extratos/${id}/lancamentos/${pendente50}/reabrir`);
    expect(res.body.lancamento.status).toBe('pendente');

    const conciliado = lancamentoPorFitid('202610020001').id;
    res = await api('post', `/extratos/${id}/lancamentos/${conciliado}/reabrir`);
    expect(res.body.lancamento).toMatchObject({ status: 'pendente', conciliado_com: null, com_taxa: false });
  });

  test('resolvendo todas as pendências o mês fecha como "conciliado"', async () => {
    const segundo169 = lancamentoPorFitid('202610080001').id;
    await api('post', `/extratos/${id}/lancamentos/${pendente74}/conciliar`).send({ pagamento_id: 'pay_d' });
    await api('post', `/extratos/${id}/lancamentos/${pendente50}/ignorar`);
    await api('post', `/extratos/${id}/lancamentos/${segundo169}/ignorar`);
    const res = await api('get', '/extratos?meses=1');
    expect(res.body.meses[0]).toMatchObject({ mes: '2026-10', status: 'conciliado', detalhe: null });
  });

  test('lançamento inexistente → 404', async () => {
    expect((await api('post', `/extratos/${id}/lancamentos/999/ignorar`)).status).toBe(404);
    expect((await api('post', `/extratos/${id}/lancamentos/999/reabrir`)).status).toBe(404);
  });
});

describe('DELETE /extratos/:id', () => {
  test('apaga o extrato e as linhas; os pagamentos voltam a ficar livres', async () => {
    const id = (await importar()).body.extrato.id;
    const res = await api('delete', `/extratos/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id, nome_arquivo: 'extrato-outubro.ofx', lancamentos_removidos: 7 });
    expect(banco.estado.extratos).toHaveLength(0);
    expect(banco.estado.lancamentos).toHaveLength(0);
    // reimportar concilia de novo
    expect((await importar()).body).toMatchObject({ conciliados: 3 });
  });

  test('inexistente → 404; id fora do formato → 400', async () => {
    expect((await api('delete', '/extratos/999')).status).toBe(404);
    expect((await api('delete', '/extratos/x')).status).toBe(400);
  });
});
