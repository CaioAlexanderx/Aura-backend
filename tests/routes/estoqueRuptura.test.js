// ============================================================
// O que vai faltar — as rotas, com o pg de mentira.
//
//   GET /companies/:id/estoque/ruptura   (loja ou consolidado)
//   GET /admin/painel/ruptura            (staff: resumo por loja)
//
// A resposta da loja é conferida contra tests/fixtures/estoque/ruptura.json
// (e a do painel contra ruptura.painel.json): é o contrato que a tela do app
// usa. Os dados vêm de tests/helpers/fakeRupturaDb.js, lojas inventadas.
//
// Mudou o formato de propósito? Regrave e revise o diff:
//   RUPTURA_FIXTURES=write npx jest tests/routes/estoqueRuptura.test.js
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const db = require('../../src/config/database');
const { requireAuth, requireCompanyAccess } = require('../../src/middleware/auth');
const fake = require('../helpers/fakeRupturaDb');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'estoque');
const SECRET = 'aura-test-secret-2026';
// Sem validade: o relógio do teste é fixo em 13/10/2026.
const staff = jwt.sign({ id: fake.USER, role: 'admin' }, SECRET);
const dono = jwt.sign({ id: fake.USER, role: 'client', company: fake.A }, SECRET);
const donoConsolidado = jwt.sign({ id: fake.USER, role: 'client', company: null, consolidated_view: true }, SECRET);

function makeApp() {
  const app = express();
  app.use(express.json());
  const scoped = express.Router({ mergeParams: true });
  scoped.use(requireAuth);
  scoped.use(requireCompanyAccess());
  scoped.use('/estoque', require('../../src/routes/estoqueRuptura'));
  app.use('/companies/:id', scoped);
  app.use('/admin/painel/ruptura', require('../../src/routes/adminPainelRuptura'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.statusCode || err.status || 500).json({ error: err.message }));
  return app;
}
const app = makeApp();
const get = (url, token) => {
  const r = request(app).get(url);
  return token ? r.set('Authorization', 'Bearer ' + token) : r;
};
const loja = (query = '', token = dono, cid = fake.A) => get(`/companies/${cid}/estoque/ruptura${query}`, token);

function conferir(nome, body) {
  const arq = path.join(FIXTURES, nome + '.json');
  if (process.env.RUPTURA_FIXTURES === 'write') {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(arq, JSON.stringify(body, null, 2) + '\n');
  }
  expect(body).toEqual(JSON.parse(fs.readFileSync(arq, 'utf8')));
}

const ITENS = /WITH vendas AS/;
const DIAS = /GROUP BY 1, 2, 3/;

beforeEach(() => {
  jest.resetAllMocks();
  jest.useFakeTimers({ now: fake.AGORA, doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask'] });
  fake.ligar(db.query);
});
afterEach(() => jest.useRealTimers());

describe('GET /companies/:id/estoque/ruptura — loja', () => {
  test('responde o contrato da tela (fixture)', async () => {
    const res = await loja();
    expect(res.status).toBe(200);
    conferir('ruptura', res.body);
  });

  test('padrões: até 30/11, janela de 14 dias, só a loja do caminho', async () => {
    const res = await loja();
    expect(res.body).toMatchObject({
      hoje: '2026-10-13', ate: '2026-11-30', janela_dias: 14, folga_pct: 20,
      janela: { de: '2026-09-29', ate: '2026-10-12' }, escopo: 'loja', empresas: [fake.A],
    });
    expect(fake.chamadas(db.query, ITENS)[0][1]).toEqual(['2026-10-13', 14, [fake.A]]);
    expect(fake.chamadas(db.query, DIAS)[0][1]).toEqual(['2026-10-13', 14, [fake.A]]);
    // Acesso + as duas consultas: nada por item.
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(fake.chamadas(db.query, /AS alcanca/)).toHaveLength(0);
  });

  test('itens prontos para a tela, na ordem em que acabam', async () => {
    const { body } = await loja();
    expect(body.itens.map((i) => [i.nome, i.data_prevista, i.faltara])).toEqual([
      ['Vestido Midi Canelado', '2026-10-17', true],
      ['Meia Cano Curto Kit 3 Pares', '2026-11-08', true],
      ['Cinto Couro Fivela Dourada', '2026-11-16', true],
      ['Calça Jeans Wide Leg', '2027-01-13', false],
    ]);
    for (const campo of ['nome', 'variante', 'codigo', 'estoque', 'ritmo_diario', 'dias_ate_acabar', 'data_prevista', 'sugestao_compra']) {
      expect(body.itens[0]).toHaveProperty(campo);
    }
    expect(body.zerados.map((i) => i.nome)).toEqual(['Blusa Básica Algodão']);
    expect(body.resumo).toMatchObject({ itens_em_risco: 3, zerados: 1, valor_em_risco: 12177.6 });
  });

  test('?ate e ?janela chegam à consulta e à conta', async () => {
    const res = await loja('?ate=2026-10-20&janela=30');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ate: '2026-10-20', janela_dias: 30, janela: { de: '2026-09-13', ate: '2026-10-12' } });
    expect(fake.chamadas(db.query, ITENS)[0][1]).toEqual(['2026-10-13', 30, [fake.A]]);
    // Até 20/10 só o vestido acaba.
    expect(res.body.itens.filter((i) => i.faltara).map((i) => i.nome)).toEqual(['Vestido Midi Canelado']);
  });

  test.each(['?ate=30-11-2026', '?ate=2026-10-01', '?janela=2', '?janela=catorze'])('parâmetro inválido %s → 400 sem consultar', async (q) => {
    const res = await loja(q);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('RUPTURA_PARAMETRO');
    expect(fake.chamadas(db.query, ITENS)).toHaveLength(0);
  });

  test('sem token → 401; sem acesso à loja → 403', async () => {
    expect((await loja('', null)).status).toBe(401);
    db.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    expect((await loja()).status).toBe(403);
  });

  test('erro do banco → 500 com mensagem da tela', async () => {
    db.query.mockImplementation((sql) => (ITENS.test(String(sql))
      ? Promise.reject(Object.assign(new Error('boom'), { code: 'XX000' }))
      : Promise.resolve({ rows: [{ role: 'owner' }] })));
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await loja();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Erro ao calcular o que vai faltar');
    erro.mockRestore();
  });
});

describe('GET /companies/:id/estoque/ruptura — consolidado', () => {
  test('token em "Todas as empresas": soma as lojas do grupo que o usuário alcança', async () => {
    const res = await loja('', donoConsolidado);
    expect(res.status).toBe(200);
    expect(res.body.escopo).toBe('grupo');
    expect(res.body.empresas).toEqual([fake.A, fake.B]);
    const [, params] = fake.chamadas(db.query, /AS alcanca/)[0];
    expect(params).toEqual([fake.A, fake.USER, false]);
    expect(fake.chamadas(db.query, ITENS)[0][1][2]).toEqual([fake.A, fake.B]);
    // O compartilhado aparece uma vez; o que é só da Filial agora entra.
    const nomes = res.body.itens.map((i) => i.nome);
    expect(nomes.filter((n) => n === 'Meia Cano Curto Kit 3 Pares')).toHaveLength(1);
    expect(nomes).toContain('Bolsa Tiracolo Caramelo');
    conferir('ruptura.grupo', res.body);
  });

  test('?escopo=grupo faz o mesmo com o token de uma loja', async () => {
    const res = await loja('?escopo=grupo');
    expect(res.body.escopo).toBe('grupo');
    expect(res.body.empresas).toEqual([fake.A, fake.B]);
  });

  test('loja do grupo que o usuário não alcança fica fora da soma', async () => {
    fake.ligar(db.query, { alcanca: [fake.A] });
    const res = await loja('', donoConsolidado);
    expect(res.body.escopo).toBe('loja');
    expect(res.body.empresas).toEqual([fake.A]);
    expect(res.body.itens.map((i) => i.nome)).not.toContain('Bolsa Tiracolo Caramelo');
  });

  test('staff alcança o grupo inteiro', async () => {
    await loja('?escopo=grupo', staff);
    expect(fake.chamadas(db.query, /AS alcanca/)[0][1]).toEqual([fake.A, fake.USER, true]);
  });
});

describe('GET /admin/painel/ruptura', () => {
  test('só staff', async () => {
    expect((await get('/admin/painel/ruptura', null)).status).toBe(401);
    expect((await get('/admin/painel/ruptura', dono)).status).toBe(403);
    expect(fake.chamadas(db.query, ITENS)).toHaveLength(0);
  });

  test('resumo por loja com itens em risco (fixture)', async () => {
    const res = await get('/admin/painel/ruptura', staff);
    expect(res.status).toBe(200);
    expect(res.body.resumo).toMatchObject({ lojas: 3, lojas_com_risco: 2, itens_em_risco: 4 });
    expect(res.body.lojas.map((l) => l.nome)).toEqual(['Boutique Aurora — Matriz', 'Boutique Aurora — Filial']);
    // Universo do painel + as duas consultas, para todas as lojas de uma vez.
    expect(db.query).toHaveBeenCalledTimes(3);
    expect(fake.chamadas(db.query, ITENS)[0][1]).toEqual(['2026-10-13', 14, [fake.A, fake.B, fake.C]]);
    conferir('ruptura.painel', res.body);
  });

  test('parâmetro inválido → 400', async () => {
    const res = await get('/admin/painel/ruptura?janela=1', staff);
    expect(res.status).toBe(400);
    expect(fake.chamadas(db.query, ITENS)).toHaveLength(0);
  });
});
